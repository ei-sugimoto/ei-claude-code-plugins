import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  DiffReviewCell,
  DiffReviewComment,
  DiffReviewFile,
  DiffReviewHunk,
  DiffReviewMode,
  DiffReviewSide,
  DiffReviewSnapshot,
  DiffReviewTarget,
  DiffReviewView,
} from '../types'
import {
  buildTree,
  commentKey,
  displayWidth,
  fillWidth,
  fitWidth,
  formatComments,
  headerOf,
  HEADER_LINES,
  isGeneratedHeader,
  isGeneratedPath,
  isInRange,
  lineLabel,
  nextTarget,
  parseCheckAttr,
  parseCommentInput,
  parseUnifiedDiff,
  toUnified,
  untrackedFile,
} from './diff'

const PANE = 'diff-review'
const MAX_UNTRACKED = 30
const MAX_UNTRACKED_BYTES = 200_000
const GUTTER = 5
// 選択中の行の背景。赤や緑の文字が読める暗めの青
const SELECTED_BG = '#1d3b5c'

const mode = atom({ plugin: 'diff-review', key: 'mode' } as const, 'branch')
const snapshot = atom({ plugin: 'diff-review', key: 'snapshot' } as const, null)
const selected = atom({ plugin: 'diff-review', key: 'selected' } as const, null)
const comments = atom({ plugin: 'diff-review', key: 'comments' } as const, [])
// GitHub の「+」と同じく、行番号をクリックした行にコメント欄を開く
const target = atom({ plugin: 'diff-review', key: 'target' } as const, null)

const INLINE_INPUT = 'inline-comment'
// split (左右) と unified (1列) のどちらで描くか。セッションをまたいで $.store にも残す
const view = atom({ plugin: 'diff-review', key: 'view' } as const, 'split')
const VIEW_STORE_KEY = 'view'

// 折りたたんだディレクトリのパス
const collapsed = atom({ plugin: 'diff-review', key: 'collapsed' } as const, [])

const showGenerated = atom({ plugin: 'diff-review', key: 'showGenerated' } as const, false)

// これより狭いペインではサイドバーをやめ、ファイルをプルダウンで選ぶ
const SIDEBAR_MIN_COLUMNS = 80
// サイドバーと左右の差分が並ぶよう、横に置くペインにはこの幅を求める (手で広げた幅があればそちらが優先)
const WANTED_COLUMNS = 140

type Base = { ref: string; label: string }

const git = ($: EngineInterface, args: string[]) => $.process.run(['git', ...args])

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

// branch モードは origin の既定ブランチとの merge-base、見つからなければ HEAD と比べる
const resolveBase = async ($: EngineInterface, current: DiffReviewMode): Promise<Base> => {
  if (current === 'uncommitted') return { ref: 'HEAD', label: 'HEAD (未コミット)' }

  const head = await git($, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [firstLine(head.stdout), 'origin/main', 'origin/master', 'main', 'master'].filter(c => c !== '')
  for (const candidate of candidates) {
    const verified = await git($, ['rev-parse', '--verify', '--quiet', candidate])
    if (verified.exitCode !== 0) continue
    const mergeBase = await git($, ['merge-base', 'HEAD', candidate])
    if (mergeBase.exitCode !== 0) continue
    const sha = firstLine(mergeBase.stdout)
    return { ref: sha, label: `${candidate} (merge-base ${sha.slice(0, 7)})` }
  }
  return { ref: 'HEAD', label: 'HEAD (既定ブランチが見つからない)' }
}

const loadUntracked = async ($: EngineInterface, root: string): Promise<DiffReviewFile[]> => {
  const listed = await git($, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])
  if (listed.exitCode !== 0) return []
  const paths = listed.stdout.split('\u0000').filter(p => p !== '').slice(0, MAX_UNTRACKED)
  const files: DiffReviewFile[] = []
  for (const path of paths) {
    try {
      const stat = await $.fs.stat(`${root}/${path}`)
      if (stat.size > MAX_UNTRACKED_BYTES) continue
      const content = await $.fs.read(`${root}/${path}`)
      if (typeof content === 'string' && !content.includes('\u0000')) files.push(untrackedFile(path, content))
    } catch {
      // 読めないファイルは一覧に出さない
    }
  }
  return files
}

const readHeader = async ($: EngineInterface, root: string, path: string): Promise<string[]> => {
  try {
    const stat = await $.fs.stat(`${root}/${path}`)
    if (stat.size > MAX_UNTRACKED_BYTES) return []
    const content = await $.fs.read(`${root}/${path}`)
    return typeof content === 'string' ? content.split('\n', HEADER_LINES) : []
  } catch {
    return []
  }
}

const markGenerated = async ($: EngineInterface, root: string, files: DiffReviewFile[]): Promise<DiffReviewFile[]> => {
  const candidates = files.filter(f => !isGeneratedPath(f.path)).map(f => f.path)
  const attr =
    candidates.length === 0
      ? new Set<string>()
      : parseCheckAttr((await $.process.run(['git', 'check-attr', '-z', 'linguist-generated', '--', ...candidates], { cwd: root })).stdout)
  return Promise.all(
    files.map(async f => {
      if (isGeneratedPath(f.path) || attr.has(f.path)) return { ...f, isGenerated: true }
      const lines = headerOf(f) ?? (f.isBinary ? [] : await readHeader($, root, f.path))
      return { ...f, isGenerated: isGeneratedHeader(f.path, lines) }
    }),
  )
}

const visibleFiles = (files: readonly DiffReviewFile[], isShown: boolean): DiffReviewFile[] =>
  isShown ? [...files] : files.filter(f => f.isGenerated !== true)

const takeSnapshot = async ($: EngineInterface, current: DiffReviewMode): Promise<DiffReviewSnapshot> => {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { baseLabel: '-', files: [], error: 'git リポジトリの中ではありません' }
  const root = firstLine(top.stdout)

  const base = await resolveBase($, current)
  const diff = await $.process.run(
    ['git', 'diff', '--no-color', '--no-ext-diff', '--find-renames', '-U3', base.ref],
    { cwd: root },
  )
  if (diff.exitCode !== 0) {
    return { baseLabel: base.label, files: [], error: firstLine(diff.stderr) || 'git diff が失敗しました' }
  }
  const files = await markGenerated($, root, [...parseUnifiedDiff(diff.stdout), ...(await loadUntracked($, root))])
  return {
    baseLabel: base.label,
    files,
    error: diff.isStdoutTruncated ? '差分が大きすぎるため途中までしか表示していません' : null,
  }
}

let isRefreshing = false

const reselect = async ($: EngineInterface, files: readonly DiffReviewFile[]) => {
  await update($, selected, path => (path !== null && files.some(f => f.path === path) ? path : (files[0]?.path ?? null)))
}

const refresh = async ($: EngineInterface): Promise<void> => {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const next = await takeSnapshot($, await read($, mode))
    await update($, snapshot, () => next)
    await reselect($, visibleFiles(next.files, await read($, showGenerated)))
  } finally {
    isRefreshing = false
  }
}

const toggleGenerated = async ($: EngineInterface) => {
  const isShown = !(await read($, showGenerated))
  await update($, showGenerated, () => isShown)
  await reselect($, visibleFiles((await read($, snapshot))?.files ?? [], isShown))
}

const isPaneOpen = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

const setView = async ($: EngineInterface, value: DiffReviewView) => {
  await update($, view, () => value)
  await $.store.set(VIEW_STORE_KEY, value)
}

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'diff-review',
      description: 'git の差分をペインで開き、行コメントを Claude に渡す',
      argumentHint: '[branch|uncommitted|split|unified|generated|close]',
    })
    const saved = await $.store.get(VIEW_STORE_KEY)
    if (saved === 'split' || saved === 'unified') await update($, view, () => saved)
    // ホットリロードでも session.start が走る。開いたままのペインを新しいコードで描き直す
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'diff-review' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'diff-review を閉じました' }
    }
    if (arg === 'branch' || arg === 'uncommitted') await update($, mode, () => arg)
    if (arg === 'split' || arg === 'unified') await setView($, arg)
    if (arg === 'generated') await update($, showGenerated, isShown => !isShown)

    const opened = await $.ui.open({ id: PANE, title: 'diff review', focus: true, columns: WANTED_COLUMNS })
    await refresh($)
    if (!opened.isPlaced) return { text: 'diff-review: ペインを置けませんでした。ターミナルを広げてください' }
    return { text: `diff-review を開きました (${await read($, mode)})` }
  })

  // 編集が入ったターンの終わりに、開いていれば差分を取り直す
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (await isPaneOpen($)) await refresh($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // mobile には Input と Select がないので、端末かデスクトップで開くよう案内だけ出す
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>diff-review は端末かデスクトップで開いてください</Text>
    }
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const current = await read($, mode)
    const snap = await read($, snapshot)
    const path = await read($, selected)
    // $.state はリロードをまたいで残るので、行範囲になる前の形で保存されたコメントは捨てる
    const notes = (await read($, comments)).filter(note => typeof note.start === 'number')
    const aimed = await read($, target)
    const closedDirs = await read($, collapsed)
    const shape = await read($, view)
    const isGeneratedShown = await read($, showGenerated)
    const files = visibleFiles(snap?.files ?? [], isGeneratedShown)
    const generatedCount = (snap?.files ?? []).filter(f => f.isGenerated === true).length
    const columns = Math.max(40, e.props.bodyColumns)
    const hasSidebar = columns >= SIDEBAR_MIN_COLUMNS
    const sideWidth = hasSidebar ? Math.min(44, Math.max(22, Math.floor(columns * 0.26))) : 0
    const diffWidth = hasSidebar ? columns - sideWidth - 1 : columns
    const half = Math.floor((diffWidth - 1) / 2)
    const file = files.find(f => f.path === path) ?? null

    // 本文は範囲の最終行の下に出し、範囲内の行には印を付ける
    const byEndLine = new Map<string, DiffReviewComment[]>()
    const noted = new Set<string>()
    for (const note of notes) {
      const key = commentKey(note.path, note.side, note.end)
      byEndLine.set(key, [...(byEndLine.get(key) ?? []), note])
      for (let line = note.start; line <= note.end; line++) noted.add(commentKey(note.path, note.side, line))
    }

    const setMode = (value: DiffReviewMode) => async () => {
      await update($, mode, () => value)
      await refresh($)
    }

    const aim = async (path: string, side: DiffReviewSide, line: number) => {
      const next = nextTarget(aimed, path, side, line)
      await update($, target, () => next)
      if (!next.isEditing) return
      // フォーカスを移せない場面 (ペインがキーを持っていない等) でも入力欄は開いたままにする
      await $.ui.focus({ requestId: PANE, key: INLINE_INPUT }).catch(() => undefined)
    }

    const cell = (path: string, side: DiffReviewSide, value: DiffReviewCell | null) => {
      if (value === null) {
        return (
          <Box width={half}>
            <Text dimColor>{' '.repeat(GUTTER)}</Text>
          </Box>
        )
      }
      const isTarget = isInRange(aimed, path, side, value.no)
      const hasNote = noted.has(commentKey(path, side, value.no))
      const color = value.kind === 'add' ? 'green' : value.kind === 'del' ? 'red' : undefined
      const sign = value.kind === 'add' ? '+' : value.kind === 'del' ? '-' : ' '
      const bg = isTarget ? SELECTED_BG : undefined
      return (
        <Box width={half} flexDirection="row" backgroundColor={bg}>
          <Button
            key={`ln-${side}-${value.no}`}
            label={String(value.no).padStart(GUTTER - 1)}
            plain
            dimColor={!isTarget && !hasNote}
            onPress={() => aim(path, side, value.no)}
          />
          <Text color={isTarget ? 'cyan' : 'yellow'} backgroundColor={bg} bold={isTarget}>
            {isTarget ? '>' : hasNote ? '*' : ' '}
          </Text>
          <Text color={color} backgroundColor={bg} bold={isTarget} wrap="truncate-end">
            {fillWidth(`${sign}${value.text}`, half - GUTTER)}
          </Text>
        </Box>
      )
    }

    const submitInline = async (value: string) => {
      const body = value.trim()
      if (aimed === null || !aimed.isEditing || body === '') return
      const { path: notePath, side, start, end } = aimed
      const note: DiffReviewComment = { id: newId(), path: notePath, side, start, end, body }
      await update($, comments, list => [...list, note])
      await update($, target, () => null)
    }

    const inlineEditor = (aimedAt: DiffReviewTarget) => (
      <Box flexDirection="column" marginLeft={GUTTER + 1} borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>
          {aimedAt.path}:{lineLabel(aimedAt.start, aimedAt.end)} ({aimedAt.side === 'L' ? '変更前' : '変更後'}) にコメント
        </Text>
        <Input key={INLINE_INPUT} placeholder="コメントを書いて Enter" submitLabel="追加" autoFocus onSubmit={submitInline} />
        <Box flexDirection="row">
          <Button key="inline-cancel" label="キャンセル" plain dimColor onPress={() => update($, target, () => null)} />
        </Box>
      </Box>
    )

    // 行の下に出すもの: その行で終わるコメントと、その行で終わる選択範囲の入力欄
    const under = (path: string, oldNo: number | null, newNo: number | null) => {
      const attached = [
        ...(oldNo !== null ? (byEndLine.get(commentKey(path, 'L', oldNo)) ?? []) : []),
        ...(newNo !== null ? (byEndLine.get(commentKey(path, 'R', newNo)) ?? []) : []),
      ]
      const isEditing =
        aimed !== null &&
        aimed.isEditing &&
        aimed.path === path &&
        ((aimed.side === 'L' && oldNo === aimed.end) || (aimed.side === 'R' && newNo === aimed.end))
      return [
        ...attached.map(note => (
          <Text color="yellow" wrap="wrap">
            {'      '}
            {note.side}
            {lineLabel(note.start, note.end)}: {note.body}
          </Text>
        )),
        ...(isEditing && aimed !== null ? [inlineEditor(aimed)] : []),
      ]
    }

    // unified は変更前と変更後の行番号を2列並べ、どちらを押してもその側の行を選ぶ
    const lineNumber = (path: string, side: DiffReviewSide, no: number | null, isLit: boolean) =>
      no === null ? (
        <Text>{' '.repeat(GUTTER - 1)}</Text>
      ) : (
        <Button
          key={`ln-${side}-${no}`}
          label={String(no).padStart(GUTTER - 1)}
          plain
          dimColor={!isLit}
          onPress={() => aim(path, side, no)}
        />
      )

    const unifiedRows = (shown: DiffReviewFile, hunk: DiffReviewHunk, hunkIndex: number) =>
      toUnified(hunk).flatMap((line, i) => {
        const isTarget =
          (line.oldNo !== null && isInRange(aimed, shown.path, 'L', line.oldNo)) ||
          (line.newNo !== null && isInRange(aimed, shown.path, 'R', line.newNo))
        const hasNote =
          (line.oldNo !== null && noted.has(commentKey(shown.path, 'L', line.oldNo))) ||
          (line.newNo !== null && noted.has(commentKey(shown.path, 'R', line.newNo)))
        const bg = isTarget ? SELECTED_BG : undefined
        const color = line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : undefined
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
        return [
          <Box flexDirection="row" key={`uni-${hunkIndex}-${i}`} backgroundColor={bg}>
            {lineNumber(shown.path, 'L', line.oldNo, isTarget || hasNote)}
            <Text backgroundColor={bg}> </Text>
            {lineNumber(shown.path, 'R', line.newNo, isTarget || hasNote)}
            <Text color={isTarget ? 'cyan' : 'yellow'} backgroundColor={bg} bold={isTarget}>
              {isTarget ? '>' : hasNote ? '*' : ' '}
            </Text>
            <Text color={color} backgroundColor={bg} bold={isTarget} wrap="truncate-end">
              {fillWidth(`${sign}${line.text}`, diffWidth - (GUTTER - 1) * 2 - 2)}
            </Text>
          </Box>,
          ...under(shown.path, line.oldNo, line.newNo),
        ]
      })

    const fileView = (shown: DiffReviewFile) => {
      if (shown.isBinary) return <Text dimColor>バイナリファイルのため表示しません</Text>
      if (shown.hunks.length === 0) return <Text dimColor>表示できる差分がありません (モード変更やリネームのみ)</Text>
      return (
        <Box flexDirection="column">
          {shown.hunks.flatMap((hunk, hunkIndex) => [
            <Text color="cyan" dimColor>
              {fitWidth(hunk.header, diffWidth)}
            </Text>,
            ...(shape === 'unified' ? unifiedRows(shown, hunk, hunkIndex) : []),
            ...(shape === 'unified' ? [] : hunk.rows).flatMap((row, r) => {
              return [
                <Box flexDirection="row" key={`row-${hunkIndex}-${r}`}>
                  {cell(shown.path, 'L', row.left)}
                  <Text dimColor>│</Text>
                  {cell(shown.path, 'R', row.right)}
                </Box>,
                ...under(shown.path, row.left?.no ?? null, row.right?.no ?? null),
              ]
            }),
          ])}
          {shown.isTruncated && <Text dimColor>... {`以降は省略しています`}</Text>}
        </Box>
      )
    }

    const submitComment = async (value: string) => {
      if (file === null) {
        $.ui.toast('diff-review: ファイルを選んでからコメントしてください')
        return
      }
      const parsed = parseCommentInput(value)
      if (parsed === null) {
        $.ui.toast('diff-review: "R12 本文" の形で入力してください (L=変更前, R=変更後)')
        return
      }
      const note: DiffReviewComment = { id: newId(), path: file.path, ...parsed }
      await update($, comments, list => [...list, note])
    }

    const selectFile = async (value: string) => {
      await update($, selected, () => value)
      await update($, target, () => null)
    }

    const toggleDir = (dir: string) =>
      update($, collapsed, list => (list.includes(dir) ? list.filter(d => d !== dir) : [...list, dir]))

    const sidebar = (files: readonly DiffReviewFile[]) => {
      // 枠線の左右2セルを除いた幅
      const inner = sideWidth - 2
      const noteCount = new Map<string, number>()
      for (const note of notes) noteCount.set(note.path, (noteCount.get(note.path) ?? 0) + 1)
      return (
        <Box flexDirection="column" width={sideWidth} borderStyle="round" borderDimColor>
          <Text bold>
            {fillWidth(`変更ファイル (${files.length})`, inner)}
          </Text>
          {buildTree(files, closedDirs).map(row => {
            const indent = '  '.repeat(row.depth)
            if (row.kind === 'dir') {
              return (
                <Button
                  key={`dir-${row.path}`}
                  label={fillWidth(`${indent}${row.isCollapsed ? '+' : '-'} ${row.name}`, inner)}
                  plain
                  dimColor
                  onPress={() => toggleDir(row.path)}
                />
              )
            }
            const isCurrent = row.path === path
            const bg = isCurrent ? SELECTED_BG : undefined
            const count = noteCount.get(row.path) ?? 0
            const added = ` +${row.file.added}`
            const removed = row.file.isUntracked ? ' new' : ` -${row.file.removed}`
            const mark = count > 0 ? ` *${count}` : ''
            const gen = row.file.isGenerated === true ? ' gen' : ''
            const nameWidth = inner - displayWidth(added + removed + mark + gen)
            return (
              <Box flexDirection="row" key={`file-row-${row.path}`} backgroundColor={bg}>
                <Button
                  key={`file-${row.path}`}
                  label={fillWidth(`${indent}  ${row.name}`, Math.max(4, nameWidth))}
                  plain
                  dimColor={!isCurrent}
                  onPress={() => selectFile(row.path)}
                />
                <Text color="green" backgroundColor={bg}>
                  {added}
                </Text>
                <Text color={row.file.isUntracked ? 'cyan' : 'red'} backgroundColor={bg}>
                  {removed}
                </Text>
                {count > 0 && (
                  <Text color="yellow" backgroundColor={bg}>
                    {mark}
                  </Text>
                )}
                {gen !== '' && (
                  <Text dimColor backgroundColor={bg}>
                    {gen}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    const diffColumn = (shown: DiffReviewFile) => (
      <Box flexDirection="column" width={diffWidth}>
        <Text bold wrap="truncate-end">
          {shown.path}
        </Text>
        {aimed !== null && !aimed.isEditing && aimed.path === shown.path ? (
          <Box flexDirection="row" gap={1}>
            <Text color="cyan">
              {aimed.side}
              {aimed.start} を起点に選択中。同じ行をもう一度押すと1行、同じ側の別の行を押すと範囲でコメントできます
            </Text>
            <Button key="anchor-cancel" label="選択解除" plain dimColor onPress={() => update($, target, () => null)} />
          </Box>
        ) : (
          <Text dimColor>行番号を2回押すとコメントできます (同じ行を2回で1行、別の行で範囲)</Text>
        )}
        {shape === 'split' && (
          <Box flexDirection="row">
            <Box width={half}>
              <Text bold wrap="truncate-end">
                {shown.oldPath === shown.path ? '変更前' : `変更前 (${shown.oldPath})`}
              </Text>
            </Box>
            <Text dimColor>│</Text>
            <Box width={half}>
              <Text bold>変更後</Text>
            </Box>
          </Box>
        )}
        {shape === 'unified' && shown.oldPath !== shown.path && <Text dimColor>{`${shown.oldPath} から名前変更`}</Text>}
        {fileView(shown)}
      </Box>
    )

    const send = async () => {
      if (notes.length === 0) {
        $.ui.toast('diff-review: コメントがありません')
        return
      }
      await $.prompt.fill({ text: formatComments(notes, snap?.baseLabel ?? '-'), mode: 'replace' })
      await update($, comments, () => [])
      $.ui.toast('diff-review: コメントをプロンプトに入れました。Enter で送信できます')
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="mode-branch" label="branch" hotkey="b" variant={current === 'branch' ? 'primary' : undefined} onPress={setMode('branch')} />
          <Button
            key="mode-uncommitted"
            label="uncommitted"
            hotkey="u"
            variant={current === 'uncommitted' ? 'primary' : undefined}
            onPress={setMode('uncommitted')}
          />
          <Button key="refresh" label="更新" hotkey="r" onPress={() => refresh($)} />
          <Text dimColor>|</Text>
          <Button key="view-split" label="split" hotkey="p" variant={shape === 'split' ? 'primary' : undefined} onPress={() => setView($, 'split')} />
          <Button key="view-unified" label="unified" hotkey="n" variant={shape === 'unified' ? 'primary' : undefined} onPress={() => setView($, 'unified')} />
          {generatedCount > 0 && <Text dimColor>|</Text>}
          {generatedCount > 0 && (
            <Button
              key="generated"
              label={isGeneratedShown ? `生成ファイルを隠す (${generatedCount})` : `生成ファイルを表示 (${generatedCount})`}
              hotkey="g"
              variant={isGeneratedShown ? 'primary' : undefined}
              onPress={() => toggleGenerated($)}
            />
          )}
        </Box>
        <Text dimColor wrap="truncate-end">
          base: {snap?.baseLabel ?? '読み込み中...'}
        </Text>
        {snap?.error != null && <Text color="red">{snap.error}</Text>}
        {snap !== null && snap.files.length === 0 && snap.error === null && <Text dimColor>差分はありません</Text>}
        {snap !== null && snap.files.length > 0 && files.length === 0 && (
          <Text dimColor>自動生成ファイルの差分だけです (g で表示)</Text>
        )}
        {files.length > 0 && hasSidebar && (
          <Box flexDirection="row" gap={1}>
            {sidebar(files)}
            {file !== null && diffColumn(file)}
          </Box>
        )}
        {files.length > 0 && !hasSidebar && (
          <Box flexDirection="column">
            <Select
              key="file"
              label="file"
              value={path ?? undefined}
              options={files.map(f => ({
                value: f.path,
                label: `${f.path}  +${f.added} -${f.removed}${f.isUntracked ? ' (untracked)' : ''}${f.isGenerated === true ? ' (generated)' : ''}`,
              }))}
              onSelect={selectFile}
            />
            {file !== null && diffColumn(file)}
          </Box>
        )}
        <Box marginTop={1} flexDirection="column">
          <Input
            key="comment"
            label="行指定"
            placeholder="R12 本文 / L3-5 本文 (L=変更前の行, R=変更後の行, 省略時 R)"
            submitLabel="追加"
            onSubmit={submitComment}
          />
          {notes.map(note => (
            <Box flexDirection="row" gap={1} key={`note-${note.id}`}>
              <Button key={`del-${note.id}`} label="x" plain dimColor onPress={() => update($, comments, list => list.filter(n => n.id !== note.id))} />
              <Text wrap="truncate-end">
                {note.path}:{note.side}
                {lineLabel(note.start, note.end)} {note.body}
              </Text>
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            <Button key="send" label={`Claude に渡す (${notes.length})`} hotkey="s" variant="primary" onPress={send} />
            <Button key="clear" label="コメントを消す" onPress={() => update($, comments, () => [])} />
          </Box>
        </Box>
      </Box>
    )
  })
}
