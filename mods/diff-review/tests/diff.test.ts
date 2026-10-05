import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_ROWS_PER_FILE,
  MAX_SELECT_OPTIONS,
  buildTree,
  displayWidth,
  gapsOf,
  hunkSpan,
  fillWidth,
  fitWidth,
  formatComments,
  headerOf,
  isGeneratedHeader,
  isGeneratedPath,
  limitOptions,
  nextTarget,
  parseBranches,
  parseCheckAttr,
  parseCommentInput,
  parseUnifiedDiff,
  revealGap,
  toUnified,
  untrackedFile,
  wrapWidth,
} from '../hooks/diff'

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1',
  '-const b = 2',
  '--- not a header',
  '+const b = 3',
  '+const c = 4',
  '+const d = 5',
  ' export { a }',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '\\ No newline at end of file',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n')

describe('parseUnifiedDiff', () => {
  test('削除と追加を左右に対にする', () => {
    const [file] = parseUnifiedDiff(SAMPLE)
    expect(file?.path).toBe('src/a.ts')
    expect(file?.added).toBe(3)
    expect(file?.removed).toBe(2)
    const rows = file?.hunks[0]?.rows ?? []
    expect(rows.length).toBe(5)
    expect(rows[0]).toEqual({
      left: { kind: 'ctx', no: 1, text: 'const a = 1' },
      right: { kind: 'ctx', no: 1, text: 'const a = 1' },
    })
    expect(rows[1]).toEqual({
      left: { kind: 'del', no: 2, text: 'const b = 2' },
      right: { kind: 'add', no: 2, text: 'const b = 3' },
    })
    expect(rows[2]).toEqual({
      left: { kind: 'del', no: 3, text: '-- not a header' },
      right: { kind: 'add', no: 3, text: 'const c = 4' },
    })
    expect(rows[3]).toEqual({ left: null, right: { kind: 'add', no: 4, text: 'const d = 5' } })
    expect(rows[4]?.right?.no).toBe(5)
  })

  test('削除ファイルとバイナリを扱う', () => {
    const files = parseUnifiedDiff(SAMPLE)
    expect(files[1]?.path).toBe('old.txt')
    expect(files[1]?.hunks[0]?.rows).toEqual([{ left: { kind: 'del', no: 1, text: 'bye' }, right: null }])
    expect(files[2]?.isBinary).toBe(true)
    expect(files[2]?.hunks).toEqual([])
  })

  test('行数の上限で切る', () => {
    const body = Array.from({ length: MAX_ROWS_PER_FILE + 10 }, (_, i) => `+line ${i}`)
    const text = ['diff --git a/x b/x', '--- /dev/null', '+++ b/x', `@@ -0,0 +1,${body.length} @@`, ...body].join('\n')
    const [file] = parseUnifiedDiff(text)
    expect(file?.isTruncated).toBe(true)
    expect(file?.hunks[0]?.rows.length).toBe(MAX_ROWS_PER_FILE)
    expect(file?.added).toBe(body.length)
  })
})

test('untracked ファイルを全行追加として組む', () => {
  const file = untrackedFile('new.md', 'a\n\tb\n')
  expect(file.isUntracked).toBe(true)
  expect(file.added).toBe(2)
  expect(file.hunks[0]?.rows[1]).toEqual({ left: null, right: { kind: 'add', no: 2, text: '  b' } })
})

test('コメント入力を読む', () => {
  expect(parseCommentInput('R12 null チェック')).toEqual({ side: 'R', start: 12, end: 12, body: 'null チェック' })
  expect(parseCommentInput('l3  消さないで ')).toEqual({ side: 'L', start: 3, end: 3, body: '消さないで' })
  expect(parseCommentInput('7 既定は変更後')).toEqual({ side: 'R', start: 7, end: 7, body: '既定は変更後' })
  expect(parseCommentInput('R15-12 逆順も範囲')).toEqual({ side: 'R', start: 12, end: 15, body: '逆順も範囲' })
  expect(parseCommentInput('本文だけ')).toBeNull()
})

test('コメントをプロンプト用に整形する', () => {
  const text = formatComments(
    [
      { id: '1', path: 'src/a.ts', side: 'R', start: 2, end: 2, body: '3 ではなく 2 のはず' },
      { id: '2', path: 'old.txt', side: 'L', start: 1, end: 3, body: '消してよいか確認' },
    ],
    'origin/main (merge-base abc1234)',
  )
  expect(text).toContain('- src/a.ts:2: 3 ではなく 2 のはず')
  expect(text).toContain('- old.txt:1-3 (変更前): 消してよいか確認')
})

test('表示幅に合わせて切り詰める', () => {
  expect(fitWidth('abc', 5)).toBe('abc')
  expect(fitWidth('abcdefgh', 5)).toBe('abcd>')
  expect(displayWidth('日本語')).toBe(6)
  expect(fitWidth('日本語です', 6)).toBe('日本 >')
  expect(displayWidth(fitWidth('日本語です', 6))).toBe(6)
  expect(fillWidth('日本', 6)).toBe('日本  ')
  expect(fillWidth('abcdefgh', 5)).toBe('abcd>')
})

test('行番号のクリックで選択が移る', () => {
  // 1回目は起点だけ (入力欄は開かない)
  const anchor = nextTarget(null, 'a.ts', 'R', 5)
  expect(anchor).toEqual({ path: 'a.ts', side: 'R', start: 5, end: 5, isEditing: false })
  // 同じ行をもう一度押すと、その1行で入力欄が開く
  expect(nextTarget(anchor, 'a.ts', 'R', 5)).toEqual({ path: 'a.ts', side: 'R', start: 5, end: 5, isEditing: true })
  // 同じ側の別の行なら範囲で開く (上に向かっても同じ)
  const range = nextTarget(anchor, 'a.ts', 'R', 2)
  expect(range).toEqual({ path: 'a.ts', side: 'R', start: 2, end: 5, isEditing: true })
  // 入力欄が開いているときに押すと、その行を新しい起点にする
  expect(nextTarget(range, 'a.ts', 'R', 3)).toEqual({ path: 'a.ts', side: 'R', start: 3, end: 3, isEditing: false })
  // 別の側や別のファイルなら起点を置き直す
  expect(nextTarget(anchor, 'a.ts', 'L', 7)).toEqual({ path: 'a.ts', side: 'L', start: 7, end: 7, isEditing: false })
  expect(nextTarget(anchor, 'b.ts', 'R', 7)).toEqual({ path: 'b.ts', side: 'R', start: 7, end: 7, isEditing: false })
})

test('変更ファイルをディレクトリの木に並べる', () => {
  const files = parseUnifiedDiff(
    ['README.md', 'apps/api/src/a.ts', 'apps/api/src/b.ts', 'apps/web/c.ts']
      .map(p => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, '@@ -1 +1 @@', '-x', '+y'].join('\n'))
      .join('\n'),
  )
  const show = (rows: ReturnType<typeof buildTree>) =>
    rows.map(r => `${'  '.repeat(r.depth)}${r.kind === 'dir' ? r.name : r.name}`)
  // 子が1つだけの apps/api/src は1行にまとめ、ディレクトリを先に並べる
  expect(show(buildTree(files, []))).toEqual(['apps/', '  api/src/', '    a.ts', '    b.ts', '  web/', '    c.ts', 'README.md'])
  // 折りたたんだディレクトリの中は出さない
  expect(show(buildTree(files, ['apps/api/src']))).toEqual(['apps/', '  api/src/', '  web/', '    c.ts', 'README.md'])
})

test('左右の対を unified の並びに戻す', () => {
  const [file] = parseUnifiedDiff(SAMPLE)
  const hunk = file?.hunks[0]
  expect(hunk).toBeDefined()
  if (hunk === undefined) return
  expect(toUnified(hunk).map(l => `${l.oldNo ?? '.'} ${l.newNo ?? '.'} ${l.kind}`)).toEqual([
    '1 1 ctx',
    '2 . del',
    '3 . del',
    '. 2 add',
    '. 3 add',
    '. 4 add',
    '4 5 ctx',
  ])
})

test('パスから自動生成ファイルを見分ける', () => {
  expect(isGeneratedPath('package-lock.json')).toBe(true)
  expect(isGeneratedPath('web/pnpm-lock.yaml')).toBe(true)
  expect(isGeneratedPath('go.sum')).toBe(true)
  expect(isGeneratedPath('api/v1/user.pb.go')).toBe(true)
  expect(isGeneratedPath('dist/app.min.js')).toBe(true)
  expect(isGeneratedPath('src/schema.generated.ts')).toBe(true)
  expect(isGeneratedPath('src/__generated__/types.ts')).toBe(true)
  expect(isGeneratedPath('vendor/github.com/x/y.go')).toBe(true)
  expect(isGeneratedPath('go.mod')).toBe(false)
  expect(isGeneratedPath('src/generator.ts')).toBe(false)
  expect(isGeneratedPath('src/app.ts')).toBe(false)
})

test('先頭行から自動生成ファイルを見分ける', () => {
  expect(isGeneratedHeader('db/query.sql.go', ['// Code generated by sqlc. DO NOT EDIT.', 'package db'])).toBe(true)
  expect(isGeneratedHeader('src/a.ts', ['// @generated', 'export {}'])).toBe(true)
  expect(isGeneratedHeader('src/a.ts', ['export const a = 1'])).toBe(false)
  expect(isGeneratedHeader('README.md', ['DO NOT EDIT の例'])).toBe(false)
  const late = [...Array.from({ length: 20 }, () => 'x'), '// DO NOT EDIT']
  expect(isGeneratedHeader('src/a.ts', late)).toBe(false)
})

test('差分から先頭行を取り出す', () => {
  const added = parseUnifiedDiff(['diff --git a/x.go b/x.go', '--- /dev/null', '+++ b/x.go', '@@ -0,0 +1,2 @@', '+// Code generated. DO NOT EDIT.', '+package x'].join('\n'))
  expect(headerOf(added[0]!)).toEqual(['// Code generated. DO NOT EDIT.', 'package x'])
  const deleted = parseUnifiedDiff(['diff --git a/y.go b/y.go', '--- a/y.go', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-// @generated', '-package y'].join('\n'))
  expect(headerOf(deleted[0]!)).toEqual(['// @generated', 'package y'])
  const middle = parseUnifiedDiff(['diff --git a/z.go b/z.go', '--- a/z.go', '+++ b/z.go', '@@ -10,1 +10,1 @@', '-a', '+b'].join('\n'))
  expect(headerOf(middle[0]!)).toBeNull()
  expect(headerOf(untrackedFile('n.ts', '// @generated\nexport {}\n'))).toEqual(['// @generated', 'export {}'])
})

test('git check-attr の出力を読む', () => {
  const out = ['api/schema.ts', 'linguist-generated', 'true', 'src/a.ts', 'linguist-generated', 'unspecified', 'gen/b.ts', 'linguist-generated', 'set', ''].join('\u0000')
  expect([...parseCheckAttr(out)]).toEqual(['api/schema.ts', 'gen/b.ts'])
  expect(parseCheckAttr('').size).toBe(0)
})

// 30行のファイルの 10 行目と 25 行目を変えた差分
const GAP_SOURCE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
const GAP_DIFF = [
  'diff --git a/g.txt b/g.txt',
  '--- a/g.txt',
  '+++ b/g.txt',
  '@@ -7,7 +7,8 @@',
  ...GAP_SOURCE.slice(6, 9).map(l => ` ${l}`),
  '-old 10',
  '+line 10',
  '+inserted',
  ...GAP_SOURCE.slice(10, 13).map(l => ` ${l}`),
  '@@ -22,7 +23,7 @@',
  ...GAP_SOURCE.slice(22, 25).map(l => ` ${l}`),
  '-old 25',
  '+line 26',
  ...GAP_SOURCE.slice(26, 29).map(l => ` ${l}`),
].join('\n')

test('hunk の間に隠れた行の範囲を求める', () => {
  const [parsed] = parseUnifiedDiff(GAP_DIFF)
  if (parsed === undefined) throw new Error('no file')
  // 変更後は10行目の後に1行増えている
  const source = [...GAP_SOURCE.slice(0, 10), 'inserted', ...GAP_SOURCE.slice(10)]
  const file = { ...parsed, source }
  expect(hunkSpan(file.hunks[0]!)).toEqual({ oldStart: 7, oldEnd: 13, newStart: 7, newEnd: 14 })
  expect(gapsOf(file)).toEqual([
    { index: 0, newStart: 1, newEnd: 6, delta: 0 },
    { index: 1, newStart: 15, newEnd: 22, delta: -1 },
    { index: 2, newStart: 30, newEnd: 31, delta: -1 },
  ])
  // 中身が読めないファイルや途中で省略したファイルの末尾は展開しない
  expect(gapsOf({ ...file, source: null })).toEqual([])
  expect(gapsOf({ ...file, isTruncated: true }).map(g => g.index)).toEqual([0, 1])

  const gap = gapsOf(file)[1]!
  const revealed = revealGap(gap, source, { top: 2, bottom: 3 })
  expect(revealed.hidden).toBe(3)
  expect(revealed.top.map(r => [r.left?.no, r.right?.no, r.right?.text])).toEqual([
    [14, 15, 'line 14'],
    [15, 16, 'line 15'],
  ])
  expect(revealed.bottom.map(r => r.right?.no)).toEqual([20, 21, 22])
  // 開きすぎても範囲に収める
  expect(revealGap(gap, source, { top: 100, bottom: 100 })).toEqual(expect.objectContaining({ hidden: 0 }))
  expect(revealGap(gap, source, { top: 100, bottom: 100 }).top.length).toBe(8)
})

test('行数0の側をもつ hunk の範囲', () => {
  expect(hunkSpan({ header: '@@ -3,2 +2,0 @@', rows: [
    { left: { kind: 'del', no: 3, text: 'a' }, right: null },
    { left: { kind: 'del', no: 4, text: 'b' }, right: null },
  ] })).toEqual({ oldStart: 3, oldEnd: 4, newStart: 3, newEnd: 2 })
})

test('比較元に選べるブランチを並べる', () => {
  const stdout = ['refs/heads/main', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/x', 'refs/remotes/upstream/main', 'refs/heads/main', ''].join('\n')
  expect(parseBranches(stdout)).toEqual(['main', 'origin/feature/x', 'upstream/main'])
})

test('Select の選択肢を上限までに絞り、選択中の値は残す', () => {
  const options = Array.from({ length: 100 }, (_, i) => ({ value: `b${i}` }))
  expect(limitOptions(options.slice(0, 3), 'b1')).toEqual(options.slice(0, 3))
  expect(limitOptions(options, 'b0')).toEqual(options.slice(0, MAX_SELECT_OPTIONS))
  const kept = limitOptions(options, 'b90')
  expect(kept).toHaveLength(MAX_SELECT_OPTIONS)
  expect(kept.at(-1)).toEqual({ value: 'b90' })
  expect(limitOptions(options, 'missing')).toEqual(options.slice(0, MAX_SELECT_OPTIONS))
})

test('表示幅で折り返して各行を埋める', () => {
  expect(wrapWidth('abcdefg', 3)).toEqual(['abc', 'def', 'g  '])
  expect(wrapWidth('', 3)).toEqual(['   '])
  // 全角が行末に入らないときは1セル空けて次の行へ送る
  expect(wrapWidth('ab日本', 3)).toEqual(['ab ', '日 ', '本 '])
})
