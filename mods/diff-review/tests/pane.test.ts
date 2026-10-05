import { expect, mock, test } from 'claude-code/testing'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  'diff --git a/docs/b.md b/docs/b.md',
  '--- a/docs/b.md',
  '+++ b/docs/b.md',
  '@@ -1 +1 @@',
  '-old note',
  '+new note',
].join('\n')

const PANE = {
  plugin: 'diff-review',
  component: 'Pane',
  requestId: 'diff-review',
  props: {
    title: 'diff review',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const ng = () => ({ exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

// テストの hook はエンジン役なので、git の応答をここで返す
const fakeGit = (argv: readonly string[]) => {
  const args = argv.slice(1).join(' ')
  if (args === 'rev-parse --show-toplevel') return ok('/repo\n')
  if (args.startsWith('symbolic-ref')) return ok('origin/main\n')
  if (args === 'rev-parse --verify --quiet origin/main') return ok('abc\n')
  if (args === 'merge-base HEAD origin/main') return ok('abc1234def\n')
  if (args.startsWith('diff ')) return ok(DIFF)
  if (args.startsWith('ls-files')) return ok('')
  return ng()
}

test('差分を左右に描き、コメントを足してプロンプトへ渡す', async ($, on) => {
  mock.store(on)
  on('process.run', (_, e) => ({ value: fakeGit(e.argv) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  await $.command.run({
    command: 'diff-review',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /merge-base abc1234/ })).toBeDefined()
    // 左のサイドバーにディレクトリとファイルが並び、押したファイルの差分が右に出る
    expect(await ui.find({ key: 'dir-docs' })).toBeDefined()
    await ui.press({ key: 'file-docs/b.md' })
    expect(await ui.find({ type: 'Text', text: /new note/ })).toBeDefined()
    await ui.press({ key: 'dir-docs' })
    expect(await ui.find({ key: 'file-docs/b.md' })).toBeUndefined()
    await ui.press({ key: 'dir-docs' })
    await ui.press({ key: 'file-src/a.ts' })
    expect(await ui.find({ type: 'Text', text: /const b = 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /const b = 3/ })).toBeDefined()

    // 1回目のクリックは起点だけで入力欄は開かず、選択解除で消せる
    await ui.press({ key: 'ln-R-1' })
    expect(await ui.find({ key: 'inline-comment' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /R1 を起点に選択中/ })).toBeDefined()
    await ui.press({ key: 'anchor-cancel' })
    expect(await ui.find({ type: 'Text', text: /R1 を起点に選択中/ })).toBeUndefined()

    // 同じ行を2回押すと、その1行で入力欄が開く
    await ui.press({ key: 'ln-L-2' })
    await ui.press({ key: 'ln-L-2' })
    expect(await ui.find({ type: 'Text', text: /src\/a.ts:2 \(変更前\) にコメント/ })).toBeDefined()

    // 入力欄が開いているときに押すと起点を置き直し、別の行を押すと範囲で開く
    await ui.press({ key: 'ln-R-1' })
    expect(await ui.find({ key: 'inline-comment' })).toBeUndefined()
    await ui.press({ key: 'ln-R-2' })
    expect(await ui.find({ type: 'Text', text: /src\/a.ts:1-2 \(変更後\) にコメント/ })).toBeDefined()
    // 選択中の2行だけ背景色が付く
    const lit = (await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor === '#302714' && /const/.test(t.text ?? ''))
    expect(lit.map(t => t.text?.trim())).toEqual(['const a = 1', '+const b = 3'])
    await ui.input({ key: 'inline-comment', text: '3 ではなく 2 のはず' })
    expect(await ui.find({ key: 'inline-comment' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /R1-2: 3 ではなく 2 のはず/ })).toBeDefined()

    // 行指定の入力欄からも足せる
    await ui.input({ key: 'comment', text: 'L2 元の値の意図は?' })
    expect(await ui.find({ type: 'Text', text: /L2: 元の値の意図は\?/ })).toBeDefined()
    expect(await ui.find({ key: 'send' })).toEqual(expect.objectContaining({ props: expect.objectContaining({ label: 'Claude に渡す (2)' }) }))

    // unified に切り替えると左右の列がなくなり、変更前と変更後の行番号が1行に並ぶ
    await ui.press({ key: 'view-unified' })
    expect(await ui.find({ type: 'Text', text: /^変更後$/ })).toBeUndefined()
    expect(await ui.find({ key: 'ln-L-2' })).toBeDefined()
    expect(await ui.find({ key: 'ln-R-2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /R1-2: 3 ではなく 2 のはず/ })).toBeDefined()
    await ui.press({ key: 'view-split' })
    expect(await ui.find({ type: 'Text', text: /^変更後$/ })).toBeDefined()

    await ui.press({ key: 'send' })
    expect(filled.at(-1)).toContain('- src/a.ts:1-2: 3 ではなく 2 のはず')
    expect(filled.at(-1)).toContain('- src/a.ts:2 (変更前): 元の値の意図は?')
    expect(await ui.find({ type: 'Text', text: /R1-2: 3 ではなく/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('狭いペインではプルダウンでファイルを選ぶ', async ($, on) => {
  on('process.run', (_, e) => ({ value: fakeGit(e.argv) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'diff-review',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 70 } })
  expect(await ui.find({ key: 'dir-src' })).toBeUndefined()
  expect(await ui.find({ key: 'file' })).toBeDefined()
  await ui.unmount()
})

test('mobile では案内だけを出す', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /端末かデスクトップ/ })).toBeDefined()
  await ui.unmount()
})

const GENERATED_DIFF = [
  DIFF,
  'diff --git a/go.sum b/go.sum',
  '--- a/go.sum',
  '+++ b/go.sum',
  '@@ -1 +1 @@',
  '-a v1',
  '+a v2',
  'diff --git a/db/query.go b/db/query.go',
  '--- /dev/null',
  '+++ b/db/query.go',
  '@@ -0,0 +1,2 @@',
  '+// Code generated by sqlc. DO NOT EDIT.',
  '+package db',
  'diff --git a/api/schema.ts b/api/schema.ts',
  '--- a/api/schema.ts',
  '+++ b/api/schema.ts',
  '@@ -5 +5 @@',
  '-x',
  '+y',
].join('\n')

test('自動生成ファイルは既定で隠し、g で表示を切り替える', async ($, on) => {
  on('process.run', (_, e) => {
    const args = e.argv.slice(1).join(' ')
    if (args.startsWith('diff ')) return { value: ok(GENERATED_DIFF) }
    if (args.startsWith('check-attr')) {
      return { value: ok(['api/schema.ts', 'linguist-generated', 'true', 'src/a.ts', 'linguist-generated', 'unspecified', ''].join('\u0000')) }
    }
    return { value: fakeGit(e.argv) }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'diff-review',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'file-src/a.ts' })).toBeDefined()
  expect(await ui.find({ key: 'file-go.sum' })).toBeUndefined()
  expect(await ui.find({ key: 'file-db/query.go' })).toBeUndefined()
  expect(await ui.find({ key: 'file-api/schema.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'generated' })).toEqual(expect.objectContaining({ props: expect.objectContaining({ label: '生成ファイルを表示 (3)' }) }))

  await ui.press({ key: 'generated' })
  expect(await ui.find({ key: 'file-go.sum' })).toBeDefined()
  expect(await ui.find({ key: 'file-db/query.go' })).toBeDefined()
  expect(await ui.find({ key: 'file-api/schema.ts' })).toBeDefined()
  await ui.press({ key: 'file-go.sum' })
  expect(await ui.find({ type: 'Text', text: /a v2/ })).toBeDefined()

  await ui.press({ key: 'generated' })
  expect(await ui.find({ key: 'file-go.sum' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /a v2/ })).toBeUndefined()
  await ui.unmount()
})

// 60行のファイルの 30 行目だけを変えた差分
const LONG_SOURCE = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
const LONG_DIFF = [
  'diff --git a/long.txt b/long.txt',
  '--- a/long.txt',
  '+++ b/long.txt',
  '@@ -27,7 +27,7 @@',
  ...LONG_SOURCE.slice(26, 29).map(l => ` ${l}`),
  '-old 30',
  '+line 30',
  ...LONG_SOURCE.slice(30, 33).map(l => ` ${l}`),
].join('\n')

test('差分のない行を展開ボタンで開く', async ($, on) => {
  mock.store(on)
  on('process.run', (_, e) => {
    const args = e.argv.slice(1).join(' ')
    if (args.startsWith('diff ')) return { value: ok(LONG_DIFF) }
    return { value: fakeGit(e.argv) }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1000, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => (e.path === '/repo/long.txt' ? { value: `${LONG_SOURCE.join('\n')}\n` } : { deny: 'ENOENT' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'diff-review',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const has = async (text: string) => (await ui.findAll({ type: 'Text' })).some(t => t.text?.trim() === text)

  // 先頭の26行は隠れていて、上へ開くボタンだけが出る (前に hunk がないので下へは出ない)
  expect(await has('line 26')).toBe(false)
  expect(await ui.find({ key: 'expand-0-down' })).toBeUndefined()
  await ui.press({ key: 'expand-0-up' })
  expect(await has('line 26')).toBe(true)
  expect(await has('line 7')).toBe(true)
  expect(await has('line 6')).toBe(false)
  // 残りが EXPAND_STEP 以下になるとまとめて開くボタンだけになり、開き切るとヘッダ行が消える
  expect(await ui.find({ key: 'expand-0-up' })).toBeUndefined()
  await ui.press({ key: 'expand-0-all' })
  expect(await has('line 1')).toBe(true)
  expect(await ui.find({ key: 'hunk-0' })).toBeUndefined()

  // 末尾の27行は下へ開く
  expect(await ui.find({ key: 'expand-1-up' })).toBeUndefined()
  await ui.press({ key: 'expand-1-down' })
  expect(await has('line 53')).toBe(true)
  expect(await has('line 54')).toBe(false)
  await ui.press({ key: 'expand-1-all' })
  expect(await has('line 60')).toBe(true)

  // 開いた行にもコメントできる
  await ui.press({ key: 'ln-R-3' })
  await ui.press({ key: 'ln-R-3' })
  expect(await ui.find({ type: 'Text', text: /long.txt:3 \(変更後\) にコメント/ })).toBeDefined()

  // unified でも同じ行が出る
  await ui.press({ key: 'view-unified' })
  expect(await has('line 60')).toBe(true)
  await ui.unmount()
})

test('branch モードで比較元のブランチを選ぶ', async ($, on) => {
  const diffs: string[] = []
  on('process.run', (_, e) => {
    const args = e.argv.slice(1).join(' ')
    if (args.startsWith('for-each-ref')) {
      return { value: ok(['refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/x', 'refs/heads/main', ''].join('\n')) }
    }
    if (args === 'rev-parse --verify --quiet origin/feature/x') return { value: ok('def\n') }
    if (args === 'merge-base HEAD origin/feature/x') return { value: ok('fea7777000\n') }
    if (args.startsWith('diff ')) diffs.push(args)
    return { value: fakeGit(e.argv) }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'diff-review',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const base = await ui.find({ key: 'base' })
  const options = (base?.props.options ?? []) as { value: string }[]
  expect(options.map(o => o.value)).toEqual([':default', 'origin/feature/x', 'main'])
  expect(await ui.find({ type: 'Text', text: /base: origin\/main/ })).toBeDefined()

  await ui.select({ key: 'base', value: 'origin/feature/x' })
  expect(diffs.at(-1)).toContain('fea7777000')
  expect(await ui.find({ type: 'Text', text: /base: origin\/feature\/x \(merge-base fea7777\)/ })).toBeDefined()

  // 既定に戻す
  await ui.select({ key: 'base', value: ':default' })
  expect(diffs.at(-1)).toContain('abc1234def')

  // コマンドでも指定でき、見つからないブランチなら HEAD と比べる
  await $.command.run({
    command: 'diff-review',
    args: 'base origin/nothing',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  expect(await ui.find({ type: 'Text', text: /HEAD \(origin\/nothing が見つからない\)/ })).toBeDefined()
  // uncommitted では比較元を選ばない
  await ui.press({ key: 'mode-uncommitted' })
  expect(await ui.find({ key: 'base' })).toBeUndefined()
  await ui.unmount()
})

test('ブランチが多くても比較元のプルダウンを描く', async ($, on) => {
  const refs = Array.from({ length: 300 }, (_, i) => `refs/heads/topic-${i}`)
  on('process.run', (_, e) => {
    const args = e.argv.slice(1).join(' ')
    if (args.startsWith('for-each-ref')) return { value: ok([...refs, ''].join('\n')) }
    if (args === 'rev-parse --verify --quiet topic-250') return { value: ok('def\n') }
    if (args === 'merge-base HEAD topic-250') return { value: ok('fea7777000\n') }
    return { value: fakeGit(e.argv) }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'diff-review',
    args: 'base topic-250',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const options = ((await ui.find({ key: 'base' }))?.props.options ?? []) as { value: string }[]
  expect(options).toHaveLength(64)
  expect(options.map(o => o.value)).toContain('topic-250')
  expect(await ui.find({ type: 'Text', text: /base: topic-250/ })).toBeDefined()
  await ui.unmount()
})

test('長い行をペイン幅で折り返し、w で切り詰めに戻す', async ($, on) => {
  mock.store(on)
  const long = `const x = '${'a'.repeat(60)}${'b'.repeat(60)}'`
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-const x = 1', `+${long}`].join('\n')
  on('process.run', (_, e) => {
    if (e.argv.slice(1).join(' ').startsWith('diff ')) return { value: ok(diff) }
    return { value: fakeGit(e.argv) }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({
    command: 'diff-review',
    args: 'split',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // 行末の b まで、続きの行に分けて出る
    expect(await ui.find({ type: 'Text', text: /bbbb/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /│/ })).length).toBeGreaterThan(1)

    await ui.press({ key: 'view-unified' })
    expect(await ui.find({ type: 'Text', text: /bbbb/ })).toBeDefined()

    await ui.press({ key: 'wrap' })
    expect(await ui.find({ type: 'Text', text: /bbbb/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: />\s*$/ })).toBeDefined()
    await ui.press({ key: 'wrap' })
    await ui.press({ key: 'view-split' })
    await ui.unmount()
  }
})
