import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  DiffReviewCell,
  DiffReviewComment,
  DiffReviewFile,
  DiffReviewRow,
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
  EXPAND_STEP,
  expansionKey,
  fillWidth,
  fitWidth,
  formatComments,
  gapsOf,
  headerOf,
  HEADER_LINES,
  isGeneratedHeader,
  isGeneratedPath,
  isInRange,
  limitOptions,
  lineLabel,
  nextTarget,
  parseBranches,
  parseCheckAttr,
  parseCommentInput,
  parseUnifiedDiff,
  revealGap,
  sanitize,
  splitLines,
  toUnified,
  untrackedFile,
  wrapWidth,
} from './diff'

const PANE = 'diff-review'
const MAX_UNTRACKED = 30
const MAX_UNTRACKED_BYTES = 200_000
// 差分のない行を展開するために読むファイルの上限
const MAX_SOURCE_BYTES = 500_000
const GUTTER = 5
// 選択中の行の背景。赤や緑の文字が読める暗めの青
const SELECTED_BG = '#302714'
const CURRENT_FILE_BG = '#262c36'
const DIFF_BG = {
  add: { line: '#12261e', num: '#1c4428' },
  del: { line: '#25171c', num: '#542426' },
} as const
const HUNK_BG = '#121d2f'
const HUNK_NUM_BG = '#0c2d6b'
const EMPTY_BG = '#151b23'
const CANVAS_BG = '#0d1117'
const FG = '#f0f6fc'
const MUTED = '#9198a1'

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

// 長い行は GitHub と同じく既定で折り返す。切り替えは $.store にも残す
const wrapped = atom({ plugin: 'diff-review', key: 'isWrapped' } as const, true)
const WRAP_STORE_KEY = 'isWrapped'

// 折りたたんだディレクトリのパス
const collapsed = atom({ plugin: 'diff-review', key: 'collapsed' } as const, [])

const showGenerated = atom({ plugin: 'diff-review', key: 'showGenerated' } as const, false)

// branch モードで比べる相手。null なら既定ブランチを探す
const baseBranch = atom({ plugin: 'diff-review', key: 'baseBranch' } as const, null)
const DEFAULT_BASE = ':default'
const MAX_BRANCHES = 200

// hunk の間で展開した行数。行番号がずれるので比べる対象を変えたら捨てる
const expanded = atom({ plugin: 'diff-review', key: 'expanded' } as const, {})

// これより狭いペインではサイドバーをやめ、ファイルをプルダウンで選ぶ
const SIDEBAR_MIN_COLUMNS = 80
// サイドバーと左右の差分が並ぶよう、横に置くペインにはこの幅を求める (手で広げた幅があればそちらが優先)
const WANTED_COLUMNS = 140

type Base = { ref: string; label: string }

const git = ($: EngineInterface, args: string[]) => $.process.run(['git', ...args])

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

// branch モードは選んだブランチ (未指定なら origin の既定ブランチ) との merge-base、見つからなければ HEAD と比べる
//   GitHub の PR と同じく、比較元が先に進んでいてもこのブランチで入れた変更だけが出る
const resolveBase = async ($: EngineInterface, current: DiffReviewMode, chosen: string | null): Promise<Base> => {
  if (current === 'uncommitted') return { ref: 'HEAD', label: 'HEAD (未コミット)' }

  const head = await git($, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const candidates =
    chosen !== null ? [chosen] : [firstLine(head.stdout), 'origin/main', 'origin/master', 'main', 'master'].filter(c => c !== '')
  for (const candidate of candidates) {
    const verified = await git($, ['rev-parse', '--verify', '--quiet', candidate])
    if (verified.exitCode !== 0) continue
    const mergeBase = await git($, ['merge-base', 'HEAD', candidate])
    if (mergeBase.exitCode !== 0) continue
    const sha = firstLine(mergeBase.stdout)
    return { ref: sha, label: `${candidate} (merge-base ${sha.slice(0, 7)})` }
  }
  return { ref: 'HEAD', label: chosen !== null ? `HEAD (${chosen} が見つからない)` : 'HEAD (既定ブランチが見つからない)' }
}

const loadBranches = async ($: EngineInterface): Promise<string[]> => {
  const listed = await git($, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  return listed.exitCode === 0 ? parseBranches(listed.stdout).slice(0, MAX_BRANCHES) : []
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

// git diff は base と作業ツリーを比べるので、変更後の中身は作業ツリーから読める
const loadSources = ($: EngineInterface, root: string, files: DiffReviewFile[]): Promise<DiffReviewFile[]> =>
  Promise.all(
    files.map(async f => {
      if (f.isBinary || f.isUntracked || f.hunks.length === 0) return f
      try {
        const stat = await $.fs.stat(`${root}/${f.path}`)
        if (stat.size > MAX_SOURCE_BYTES) return f
        const content = await $.fs.read(`${root}/${f.path}`)
        return typeof content === 'string' ? { ...f, source: splitLines(content).map(sanitize) } : f
      } catch {
        // 削除したファイルなどは展開しない
        return f
      }
    }),
  )

const visibleFiles = (files: readonly DiffReviewFile[], isShown: boolean): DiffReviewFile[] =>
  isShown ? [...files] : files.filter(f => f.isGenerated !== true)

const takeSnapshot = async ($: EngineInterface, current: DiffReviewMode, chosen: string | null): Promise<DiffReviewSnapshot> => {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { baseLabel: '-', files: [], error: 'git リポジトリの中ではありません' }
  const root = firstLine(top.stdout)

  const base = await resolveBase($, current, chosen)
  const branches = current === 'branch' ? await loadBranches($) : []
  const diff = await $.process.run(
    ['git', 'diff', '--no-color', '--no-ext-diff', '--find-renames', '-U3', base.ref],
    { cwd: root },
  )
  if (diff.exitCode !== 0) {
    return { baseLabel: base.label, branches, files: [], error: firstLine(diff.stderr) || 'git diff が失敗しました' }
  }
  const parsed = await loadSources($, root, parseUnifiedDiff(diff.stdout))
  const files = await markGenerated($, root, [...parsed, ...(await loadUntracked($, root))])
  return {
    baseLabel: base.label,
    branches,
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
    const next = await takeSnapshot($, await read($, mode), await read($, baseBranch))
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

// 比較元を変えると行番号がずれるので、展開した行は捨てる
const setBaseBranch = async ($: EngineInterface, value: string | null) => {
  await update($, baseBranch, () => value)
  await update($, mode, () => 'branch')
  await update($, expanded, () => ({}))
}

const isPaneOpen = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

const setView = async ($: EngineInterface, value: DiffReviewView) => {
  await update($, view, () => value)
  await $.store.set(VIEW_STORE_KEY, value)
}

const toggleWrap = async ($: EngineInterface) => {
  const isWrapped = !(await read($, wrapped))
  await update($, wrapped, () => isWrapped)
  await $.store.set(WRAP_STORE_KEY, isWrapped)
}

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'diff-review',
      description: 'git の差分をペインで開き、行コメントを Claude に渡す',
      argumentHint: '[branch|uncommitted|base <branch>|split|unified|wrap|generated|close]',
    })
    const saved = await $.store.get(VIEW_STORE_KEY)
    if (saved === 'split' || saved === 'unified') await update($, view, () => saved)
    const savedWrap = await $.store.get(WRAP_STORE_KEY)
    if (typeof savedWrap === 'boolean') await update($, wrapped, () => savedWrap)
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
    if (arg === 'branch' || arg === 'uncommitted') {
      await update($, mode, () => arg)
      await update($, expanded, () => ({}))
    }
    // "base origin/feature" で比較元を選ぶ。"base" だけなら既定ブランチに戻す
    const baseArg = /^base(?:\s+(\S+))?$/.exec(arg)
    if (baseArg !== null) await setBaseBranch($, baseArg[1] ?? null)
    if (arg === 'split' || arg === 'unified') await setView($, arg)
    if (arg === 'wrap') await toggleWrap($)
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
    const isWrapped = await read($, wrapped)
    const opened = await read($, expanded)
    const chosenBase = await read($, baseBranch)
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
      await update($, expanded, () => ({}))
      await refresh($)
    }

    const aim = async (path: string, side: DiffReviewSide, line: number) => {
      const next = nextTarget(aimed, path, side, line)
      await update($, target, () => next)
      if (!next.isEditing) return
      // フォーカスを移せない場面 (ペインがキーを持っていない等) でも入力欄は開いたままにする
      await $.ui.focus({ requestId: PANE, key: INLINE_INPUT }).catch(() => undefined)
    }

    // 記号のあとの本文を幅 width で折り返し、2行目以降は記号の列を空ける。折り返さないときは1行に切り詰める
    const bodyLines = (sign: string, text: string, width: number): string[] =>
      isWrapped ? wrapWidth(text, width - 1).map((chunk, i) => `${i === 0 ? sign : ' '}${chunk}`) : [fillWidth(`${sign}${text}`, width)]

    const signOf = (kind: DiffReviewCell['kind']) => (kind === 'add' ? '+' : kind === 'del' ? '-' : ' ')

    const cellLines = (value: DiffReviewCell | null): string[] =>
      value === null ? [] : bodyLines(signOf(value.kind), value.text, half - GUTTER)

    // 左右で折り返した行数が違うときは、短い側を height 行まで空行で埋めて高さを揃える
    const cell = (path: string, side: DiffReviewSide, value: DiffReviewCell | null, lines: readonly string[], height: number) => {
      if (value === null) {
        return (
          <Box width={half} flexDirection="column" backgroundColor={EMPTY_BG}>
            {Array.from({ length: height }, () => (
              <Text backgroundColor={EMPTY_BG}>{' '.repeat(half)}</Text>
            ))}
          </Box>
        )
      }
      const isTarget = isInRange(aimed, path, side, value.no)
      const hasNote = noted.has(commentKey(path, side, value.no))
      const tone = value.kind === 'ctx' ? undefined : DIFF_BG[value.kind]
      const bg = isTarget ? SELECTED_BG : (tone?.line ?? CANVAS_BG)
      const numBg = isTarget ? SELECTED_BG : (tone?.num ?? CANVAS_BG)
      const padded = [...lines, ...Array.from({ length: height - lines.length }, () => ' '.repeat(half - GUTTER))]
      return (
        <Box width={half} flexDirection="column" backgroundColor={bg}>
          {padded.map((line, i) => (
            <Box flexDirection="row" backgroundColor={bg}>
              {i === 0 ? (
                <Box backgroundColor={numBg}>
                  <Button
                    key={`ln-${side}-${value.no}`}
                    label={String(value.no).padStart(GUTTER - 1)}
                    plain
                    dimColor={tone === undefined && !isTarget && !hasNote}
                    onPress={() => aim(path, side, value.no)}
                  />
                </Box>
              ) : (
                <Text backgroundColor={numBg}>{' '.repeat(GUTTER - 1)}</Text>
              )}
              <Text color={isTarget ? 'cyan' : 'yellow'} backgroundColor={numBg} bold={isTarget}>
                {i === 0 && isTarget ? '>' : i === 0 && hasNote ? '*' : ' '}
              </Text>
              <Text color={FG} backgroundColor={bg} bold={isTarget} wrap="truncate-end">
                {line}
              </Text>
            </Box>
          ))}
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
    const lineNumber = (path: string, side: DiffReviewSide, no: number | null, isLit: boolean, numBg: string | undefined) =>
      no === null ? (
        <Text backgroundColor={numBg}>{' '.repeat(GUTTER - 1)}</Text>
      ) : (
        <Box backgroundColor={numBg}>
          <Button
            key={`ln-${side}-${no}`}
            label={String(no).padStart(GUTTER - 1)}
            plain
            dimColor={!isLit}
            onPress={() => aim(path, side, no)}
          />
        </Box>
      )

    const unifiedRows = (shown: DiffReviewFile, rows: readonly DiffReviewRow[], prefix: string) =>
      toUnified({ header: '', rows: [...rows] }).flatMap((line, i) => {
        const isTarget =
          (line.oldNo !== null && isInRange(aimed, shown.path, 'L', line.oldNo)) ||
          (line.newNo !== null && isInRange(aimed, shown.path, 'R', line.newNo))
        const hasNote =
          (line.oldNo !== null && noted.has(commentKey(shown.path, 'L', line.oldNo))) ||
          (line.newNo !== null && noted.has(commentKey(shown.path, 'R', line.newNo)))
        const tone = line.kind === 'ctx' ? undefined : DIFF_BG[line.kind]
        const bg = isTarget ? SELECTED_BG : (tone?.line ?? CANVAS_BG)
        const numBg = isTarget ? SELECTED_BG : (tone?.num ?? CANVAS_BG)
        const isLit = tone !== undefined || isTarget || hasNote
        const gutter = (GUTTER - 1) * 2 + 2
        return [
          ...bodyLines(signOf(line.kind), line.text, diffWidth - gutter).map((body, part) => (
            <Box flexDirection="row" key={`uni-${prefix}-${i}-${part}`} backgroundColor={bg}>
              {part === 0 ? (
                [
                  lineNumber(shown.path, 'L', line.oldNo, isLit, numBg),
                  <Text backgroundColor={numBg}> </Text>,
                  lineNumber(shown.path, 'R', line.newNo, isLit, numBg),
                ]
              ) : (
                <Text backgroundColor={numBg}>{' '.repeat(gutter - 1)}</Text>
              )}
              <Text color={isTarget ? 'cyan' : 'yellow'} backgroundColor={numBg} bold={isTarget}>
                {part === 0 && isTarget ? '>' : part === 0 && hasNote ? '*' : ' '}
              </Text>
              <Text color={FG} backgroundColor={bg} bold={isTarget} wrap="truncate-end">
                {body}
              </Text>
            </Box>
          )),
          ...under(shown.path, line.oldNo, line.newNo),
        ]
      })

    const splitRows = (shown: DiffReviewFile, rows: readonly DiffReviewRow[], prefix: string) =>
      rows.flatMap((row, r) => {
        const left = cellLines(row.left)
        const right = cellLines(row.right)
        const height = Math.max(1, left.length, right.length)
        return [
          <Box flexDirection="row" key={`row-${prefix}-${r}`}>
            {cell(shown.path, 'L', row.left, left, height)}
            <Box flexDirection="column">
              {Array.from({ length: height }, () => (
                <Text color={MUTED} backgroundColor={CANVAS_BG}>│</Text>
              ))}
            </Box>
            {cell(shown.path, 'R', row.right, right, height)}
          </Box>,
          ...under(shown.path, row.left?.no ?? null, row.right?.no ?? null),
        ]
      })

    const rowsOf = (shown: DiffReviewFile, rows: readonly DiffReviewRow[], prefix: string) =>
      shape === 'unified' ? unifiedRows(shown, rows, prefix) : splitRows(shown, rows, prefix)

    const expand = (key: string, top: number, bottom: number) =>
      update($, expanded, all => ({ ...all, [key]: { top, bottom } }))

    // hunk のヘッダ行。前に隠れた行があれば、GitHub と同じく展開ボタンを並べる
    const hunkHeader = (index: number, header: string, buttons: { key: string; label: string; onPress: () => unknown }[]) => {
      const used = buttons.reduce((sum, button) => sum + displayWidth(button.label) + 1, 0)
      return (
        <Box flexDirection="row" key={`hunk-${index}`} backgroundColor={HUNK_BG}>
          <Text backgroundColor={HUNK_NUM_BG}>{' '.repeat(GUTTER)}</Text>
          {buttons.flatMap(button => [
            <Text backgroundColor={HUNK_BG}> </Text>,
            <Button key={button.key} label={button.label} plain onPress={button.onPress} />,
          ])}
          <Text color={MUTED} backgroundColor={HUNK_BG}>
            {fillWidth(` ${header}`, diffWidth - GUTTER - used)}
          </Text>
        </Box>
      )
    }

    // index 番目の hunk の前 (hunks.length なら最後の hunk の後) に隠れた行と、その展開ボタン
    //   隠れた行が残っていれば、上 (前の hunk の続き) と下 (次の hunk の手前) から EXPAND_STEP 行ずつ開ける
    //   すべて開いたら、間のヘッダ行も消して前後をつなげる
    const gapBlock = (shown: DiffReviewFile, index: number, header: string | null) => {
      const gap = gapsOf(shown).find(g => g.index === index)
      if (gap === undefined || shown.source == null) return header === null ? [] : [hunkHeader(index, header, [])]
      const key = expansionKey(shown.path, index)
      const state = opened[key] ?? { top: 0, bottom: 0 }
      const revealed = revealGap(gap, shown.source, state)
      const size = revealed.top.length + revealed.bottom.length + revealed.hidden
      const isFirst = index === 0
      const isLast = index === shown.hunks.length
      const buttons =
        revealed.hidden === 0
          ? []
          : revealed.hidden <= EXPAND_STEP
            ? [{ key: `expand-${index}-all`, label: `${revealed.hidden}行を展開`, onPress: () => expand(key, size, 0) }]
            : [
                ...(isFirst ? [] : [{ key: `expand-${index}-down`, label: `下へ${EXPAND_STEP}行`, onPress: () => expand(key, state.top + EXPAND_STEP, state.bottom) }]),
                ...(isLast ? [] : [{ key: `expand-${index}-up`, label: `上へ${EXPAND_STEP}行`, onPress: () => expand(key, state.top, state.bottom + EXPAND_STEP) }]),
                { key: `expand-${index}-all`, label: `すべて (${revealed.hidden}行)`, onPress: () => expand(key, size, 0) },
              ]
      const isHeaderShown = header !== null ? size === 0 || revealed.hidden > 0 : revealed.hidden > 0
      return [
        ...rowsOf(shown, revealed.top, `gap-${index}-top`),
        ...(isHeaderShown ? [hunkHeader(index, header ?? '', buttons)] : []),
        ...rowsOf(shown, revealed.bottom, `gap-${index}-bottom`),
      ]
    }

    const fileView = (shown: DiffReviewFile) => {
      if (shown.isBinary) return <Text dimColor>バイナリファイルのため表示しません</Text>
      if (shown.hunks.length === 0) return <Text dimColor>表示できる差分がありません (モード変更やリネームのみ)</Text>
      return (
        <Box flexDirection="column">
          {shown.hunks.flatMap((hunk, hunkIndex) => [
            ...gapBlock(shown, hunkIndex, hunk.header),
            ...rowsOf(shown, hunk.rows, `${hunkIndex}`),
          ])}
          {gapBlock(shown, shown.hunks.length, null)}
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
            const bg = isCurrent ? CURRENT_FILE_BG : undefined
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
          <Button key="wrap" label="折り返し" hotkey="w" variant={isWrapped ? 'primary' : undefined} onPress={() => toggleWrap($)} />
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
        {current === 'branch' && (
          <Select
            key="base"
            label="比較元"
            value={chosenBase ?? DEFAULT_BASE}
            options={limitOptions(
              [
                { value: DEFAULT_BASE, label: '既定ブランチ (origin/HEAD)' },
                // コマンドで一覧にないものを指定したときも、選んだものが見えるように足す
                ...(chosenBase !== null && !(snap?.branches ?? []).includes(chosenBase) ? [chosenBase] : []).map(b => ({ value: b, label: b })),
                ...(snap?.branches ?? []).map(b => ({ value: b, label: b })),
              ],
              chosenBase ?? DEFAULT_BASE,
            )}
            onSelect={async value => {
              await setBaseBranch($, value === DEFAULT_BASE ? null : value)
              await refresh($)
            }}
          />
        )}
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
              options={limitOptions(
                files.map(f => ({
                  value: f.path,
                  label: `${f.path}  +${f.added} -${f.removed}${f.isUntracked ? ' (untracked)' : ''}${f.isGenerated === true ? ' (generated)' : ''}`,
                })),
                path,
              )}
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
