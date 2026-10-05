import type {
  DiffReviewCell,
  DiffReviewComment,
  DiffReviewExpansion,
  DiffReviewFile,
  DiffReviewHunk,
  DiffReviewRow,
  DiffReviewSide,
  DiffReviewRange,
  DiffReviewTarget,
} from '../types'

export const MAX_ROWS_PER_FILE = 400

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// 端末で幅が狂う制御文字を落とし、タブは空白2つに置き換える
export const sanitize = (text: string): string =>
  text.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, '')

// 全角文字 (CJK、全角記号、絵文字) を2セルとして数える
const cellWidth = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1
}

// 端末の切り詰めに任せると行が2段になることがあるため、表示幅で先に切っておく
export const displayWidth = (text: string): number => {
  let width = 0
  for (const char of text) width += cellWidth(char)
  return width
}

export const fitWidth = (text: string, columns: number): string => {
  if (columns <= 0) return ''
  if (displayWidth(text) <= columns) return text
  // 末尾1セルを切れた印 ">" にあて、全角で1セル余ったら空白で詰める
  const budget = columns - 1
  let used = 0
  let out = ''
  for (const char of text) {
    const width = cellWidth(char)
    if (used + width > budget) break
    out += char
    used += width
  }
  return `${out}${' '.repeat(budget - used)}>`
}

// 背景色をセルの端まで塗るため、表示幅いっぱいまで空白で埋める
export const fillWidth = (text: string, columns: number): string => {
  const fitted = fitWidth(text, columns)
  return `${fitted}${' '.repeat(Math.max(0, columns - displayWidth(fitted)))}`
}

const stripPrefix = (path: string): string => path.replace(/^[ab]\//, '')

const newFile = (path: string): DiffReviewFile => ({
  path,
  oldPath: path,
  added: 0,
  removed: 0,
  isBinary: false,
  isUntracked: false,
  isTruncated: false,
  isGenerated: false,
  hunks: [],
  source: null,
})

// ファイルの中身を行に分ける。末尾の改行は最終行の後ろの空行として数えない
export const splitLines = (content: string): string[] =>
  content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')

const countRows = (file: DiffReviewFile): number =>
  file.hunks.reduce((sum, hunk) => sum + hunk.rows.length, 0)

// 削除行と追加行を上から順に左右へ対にし、余った側は空セルで埋める
const pairRows = (dels: DiffReviewCell[], adds: DiffReviewCell[]): DiffReviewRow[] => {
  const rows: DiffReviewRow[] = []
  for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
    rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
  }
  return rows
}

export const parseUnifiedDiff = (text: string): DiffReviewFile[] => {
  const files: DiffReviewFile[] = []
  let file: DiffReviewFile | null = null
  let hunk: DiffReviewHunk | null = null
  let oldNo = 0
  let newNo = 0
  let dels: DiffReviewCell[] = []
  let adds: DiffReviewCell[] = []

  const flush = () => {
    if (hunk !== null && (dels.length > 0 || adds.length > 0)) {
      hunk.rows.push(...pairRows(dels, adds))
    }
    dels = []
    adds = []
  }

  const push = (row: DiffReviewRow) => {
    if (hunk !== null) hunk.rows.push(row)
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      hunk = null
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      file = newFile(match?.[2] ?? line.slice('diff --git '.length))
      if (match?.[1] !== undefined) file.oldPath = match[1]
      files.push(file)
      continue
    }
    if (file === null) continue

    // hunk の中では先頭1文字が行の種類を表す。"--- " で始まる削除行もここで扱う
    if (hunk !== null) {
      const body = sanitize(line.slice(1))
      if (line[0] === '-') {
        dels.push({ kind: 'del', no: oldNo++, text: body })
        file.removed++
        continue
      }
      if (line[0] === '+') {
        adds.push({ kind: 'add', no: newNo++, text: body })
        file.added++
        continue
      }
      if (line[0] === ' ') {
        flush()
        push({
          left: { kind: 'ctx', no: oldNo++, text: body },
          right: { kind: 'ctx', no: newNo++, text: body },
        })
        continue
      }
      // "\ No newline at end of file" は表示しない
      if (line[0] === '\\') continue
    }

    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      flush()
      hunk = null
      if (countRows(file) >= MAX_ROWS_PER_FILE) {
        file.isTruncated = true
        continue
      }
      oldNo = Number(header[1])
      newNo = Number(header[2])
      hunk = { header: sanitize(line), rows: [] }
      file.hunks.push(hunk)
      continue
    }
    if (line.startsWith('--- ')) {
      const path = line.slice(4)
      if (path !== '/dev/null') file.oldPath = stripPrefix(path)
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4)
      file.path = path === '/dev/null' ? file.oldPath : stripPrefix(path)
      continue
    }
    if (line.startsWith('Binary files ')) file.isBinary = true
  }
  flush()

  for (const one of files) {
    let left = MAX_ROWS_PER_FILE
    for (const h of one.hunks) {
      if (h.rows.length > left) {
        h.rows = h.rows.slice(0, Math.max(0, left))
        one.isTruncated = true
      }
      left -= h.rows.length
    }
    one.hunks = one.hunks.filter(h => h.rows.length > 0)
  }
  return files
}

// untracked なファイルは git diff に出ないので、全行追加として組み立てる
export const untrackedFile = (path: string, content: string): DiffReviewFile => {
  const lines = splitLines(content)
  const file = newFile(path)
  file.isUntracked = true
  file.added = lines.length
  const shown = lines.slice(0, MAX_ROWS_PER_FILE)
  file.isTruncated = lines.length > shown.length
  file.hunks = [
    {
      header: `@@ -0,0 +1,${lines.length} @@ (untracked)`,
      rows: shown.map((text, i) => ({ left: null, right: { kind: 'add', no: i + 1, text: sanitize(text) } })),
    },
  ]
  return file
}

const GENERATED_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'composer.lock',
  'Cargo.lock',
  'go.sum',
  'pubspec.lock',
  'flake.lock',
  'Package.resolved',
  'packages.lock.json',
  'gradle.lockfile',
  '.terraform.lock.hcl',
])

const GENERATED_SUFFIXES = [
  '.min.js',
  '.min.css',
  '.map',
  '.pb.go',
  '.pb.cc',
  '.pb.h',
  '_pb2.py',
  '_pb2_grpc.py',
  '_pb2.pyi',
  '_string.go',
  '.g.dart',
  '.freezed.dart',
  '.g.cs',
  '.designer.cs',
]

const GENERATED_PREFIXES = ['vendor/', 'node_modules/']

const GENERATED_DIRS = ['__generated__', 'generated']

const GENERATED_HEADERS = [/@generated\b/, /\bDO NOT EDIT\b/i, /\bauto-?generated\b/i, /<auto-generated/i]

export const HEADER_LINES = 20

export const isGeneratedPath = (path: string): boolean => {
  const parts = path.split('/')
  const name = parts.at(-1) ?? path
  return (
    GENERATED_NAMES.has(name) ||
    GENERATED_SUFFIXES.some(suffix => name.endsWith(suffix)) ||
    /\.(generated|gen)\.\w+$/.test(name) ||
    GENERATED_PREFIXES.some(prefix => path.startsWith(prefix)) ||
    parts.slice(0, -1).some(dir => GENERATED_DIRS.includes(dir))
  )
}

export const isGeneratedHeader = (path: string, lines: readonly string[]): boolean => {
  if (/\.(md|markdown)$/i.test(path)) return false
  const header = lines.slice(0, HEADER_LINES).join('\n')
  return GENERATED_HEADERS.some(pattern => pattern.test(header))
}

export const headerOf = (file: DiffReviewFile): string[] | null => {
  const first = file.hunks[0]
  const header = first === undefined ? null : HUNK_HEADER.exec(first.header)
  if (first === undefined || header === null) return null
  if (header[2] === '1') return first.rows.flatMap(row => (row.right === null ? [] : [row.right.text])).slice(0, HEADER_LINES)
  if (header[1] === '1' && header[2] === '0') {
    return first.rows.flatMap(row => (row.left === null ? [] : [row.left.text])).slice(0, HEADER_LINES)
  }
  return null
}

export const parseCheckAttr = (stdout: string): Set<string> => {
  const parts = stdout.split('\u0000')
  const paths = new Set<string>()
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const value = parts[i + 2]
    if (parts[i + 1] === 'linguist-generated' && (value === 'true' || value === 'set')) paths.add(parts[i] ?? '')
  }
  return paths
}

// Select の options は 64 件までで、超えるとペイン全体が描かれない
export const MAX_SELECT_OPTIONS = 64

// 先頭から上限まで残す。選択中の値が溢れたときは最後の1件と入れ替えて残す
export const limitOptions = <T extends { value: string }>(options: readonly T[], keep: string | null | undefined): T[] => {
  if (options.length <= MAX_SELECT_OPTIONS) return [...options]
  const head = options.slice(0, MAX_SELECT_OPTIONS)
  if (keep == null || head.some(o => o.value === keep)) return head
  const kept = options.find(o => o.value === keep)
  return kept === undefined ? head : [...head.slice(0, -1), kept]
}

// git for-each-ref --format=%(refname) の出力を、比較元に選べるブランチ名 (main, origin/feature 等) にする
//   origin/HEAD は既定ブランチを指すだけの別名なので除く
export const parseBranches = (stdout: string): string[] => {
  const names = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(ref => ref !== '' && !/^refs\/remotes\/[^/]+\/HEAD$/.test(ref))
    .map(ref => ref.replace(/^refs\/(heads|remotes)\//, ''))
  return [...new Set(names)]
}

export type ParsedComment ={ side: DiffReviewSide; start: number; end: number; body: string }

// "R12 本文" / "L3-5 本文" / "12 本文" (省略時は変更後の側) を読む
export const parseCommentInput = (value: string): ParsedComment | null => {
  const match = /^\s*([LRlr])?(\d+)(?:-(\d+))?\s+([\s\S]+?)\s*$/.exec(value)
  if (match === null) return null
  const side: DiffReviewSide = match[1]?.toUpperCase() === 'L' ? 'L' : 'R'
  const a = Number(match[2])
  const b = match[3] === undefined ? a : Number(match[3])
  return { side, start: Math.min(a, b), end: Math.max(a, b), body: match[4] ?? '' }
}

export const commentKey = (path: string, side: DiffReviewSide, line: number): string =>
  `${path}\u0000${side}${line}`

export const lineLabel = (start: number, end: number): string => (start === end ? `${start}` : `${start}-${end}`)

export const isInRange = (range: DiffReviewRange | null, path: string, side: DiffReviewSide, line: number): boolean =>
  range !== null && range.path === path && range.side === side && range.start <= line && line <= range.end

// 行番号を押したときの選択の移り方。修飾キーは届かないので、2回のクリックで範囲を決める
//   起点なし / 入力欄が開いている / 別の側や別のファイル -> その行を起点にする (入力欄はまだ開かない)
//   起点ありで同じ行                                   -> その1行で入力欄を開く
//   起点ありで同じファイル同じ側の別の行               -> 起点からその行までの範囲で入力欄を開く
export const nextTarget = (
  current: DiffReviewTarget | null,
  path: string,
  side: DiffReviewSide,
  line: number,
): DiffReviewTarget => {
  const anchor: DiffReviewTarget = { path, side, start: line, end: line, isEditing: false }
  if (current === null || current.isEditing || current.path !== path || current.side !== side) return anchor
  return { path, side, start: Math.min(current.start, line), end: Math.max(current.start, line), isEditing: true }
}

export const formatComments = (comments: readonly DiffReviewComment[], baseLabel: string): string => {
  const lines = comments.map(c => {
    const where = `${c.path}:${lineLabel(c.start, c.end)}${c.side === 'L' ? ' (変更前)' : ''}`
    return `- ${where}: ${c.body}`
  })
  return [`差分 (base: ${baseLabel}) へのレビューコメントです。それぞれ対応してください。`, '', ...lines].join('\n')
}

export type TreeRow =
  | { kind: 'dir'; path: string; name: string; depth: number; isCollapsed: boolean }
  | { kind: 'file'; path: string; name: string; depth: number; file: DiffReviewFile }

type TreeNode = { name: string; path: string; dirs: Map<string, TreeNode>; files: DiffReviewFile[] }

const newNode = (name: string, path: string): TreeNode => ({ name, path, dirs: new Map(), files: [] })

// 変更ファイルをディレクトリ構造の行に並べる。子が1つだけのディレクトリは "a/b/" のように1行にまとめる
export const buildTree = (files: readonly DiffReviewFile[], collapsed: readonly string[]): TreeRow[] => {
  const root = newNode('', '')
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      const path = node.path === '' ? part : `${node.path}/${part}`
      const child = node.dirs.get(part) ?? newNode(part, path)
      node.dirs.set(part, child)
      node = child
    }
    node.files.push(file)
  }

  const closed = new Set(collapsed)
  const rows: TreeRow[] = []
  const walk = (node: TreeNode, depth: number) => {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let merged = dir
      let name = dir.name
      while (merged.files.length === 0 && merged.dirs.size === 1) {
        const only = [...merged.dirs.values()][0]
        if (only === undefined) break
        merged = only
        name = `${name}/${only.name}`
      }
      const isCollapsed = closed.has(merged.path)
      rows.push({ kind: 'dir', path: merged.path, name: `${name}/`, depth, isCollapsed })
      if (!isCollapsed) walk(merged, depth + 1)
    }
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', path: file.path, name: file.path.split('/').pop() ?? file.path, depth, file })
    }
  }
  walk(root, 0)
  return rows
}

export type UnifiedLine = {
  kind: DiffReviewCell['kind']
  oldNo: number | null
  newNo: number | null
  text: string
}

// split 用に左右へ対にした行を、unified の並び (変更の塊ごとに削除行をまとめて先、追加行を後) に戻す
export const toUnified = (hunk: DiffReviewHunk): UnifiedLine[] => {
  const lines: UnifiedLine[] = []
  let dels: UnifiedLine[] = []
  let adds: UnifiedLine[] = []
  const flush = () => {
    lines.push(...dels, ...adds)
    dels = []
    adds = []
  }
  for (const row of hunk.rows) {
    if (row.left?.kind === 'ctx' && row.right?.kind === 'ctx') {
      flush()
      lines.push({ kind: 'ctx', oldNo: row.left.no, newNo: row.right.no, text: row.right.text })
      continue
    }
    if (row.left !== null) dels.push({ kind: 'del', oldNo: row.left.no, newNo: null, text: row.left.text })
    if (row.right !== null) adds.push({ kind: 'add', oldNo: null, newNo: row.right.no, text: row.right.text })
  }
  flush()
  return lines
}

// GitHub と同じく、展開ボタン1回で見せる行数
export const EXPAND_STEP = 20

type HunkSpan = { oldStart: number; oldEnd: number; newStart: number; newEnd: number }

// hunk が占める行の範囲。行数0の側 ("+5,0" 等) はヘッダの行の直後から始まる空の範囲になる
export const hunkSpan = (hunk: DiffReviewHunk): HunkSpan | null => {
  const header = HUNK_HEADER.exec(hunk.header)
  if (header === null) return null
  const oldCount = hunk.rows.filter(row => row.left !== null).length
  const newCount = hunk.rows.filter(row => row.right !== null).length
  const oldStart = Number(header[1]) + (oldCount === 0 ? 1 : 0)
  const newStart = Number(header[2]) + (newCount === 0 ? 1 : 0)
  return { oldStart, oldEnd: oldStart + oldCount - 1, newStart, newEnd: newStart + newCount - 1 }
}

// hunk の前 (index === hunks.length なら最後の hunk の後) に隠れている、変更後の側の行範囲
//   delta は変更前の行番号 - 変更後の行番号。差分のない行なのでこの範囲では一定
export type DiffReviewGap = { index: number; newStart: number; newEnd: number; delta: number }

export const gapsOf = (file: DiffReviewFile): DiffReviewGap[] => {
  if (file.source == null || file.isBinary || file.isUntracked) return []
  const spans = file.hunks.map(hunkSpan)
  if (spans.length === 0 || spans.some(span => span === null)) return []
  const known = spans as HunkSpan[]
  const gaps: DiffReviewGap[] = known.map((span, index) => {
    const prev = known[index - 1]
    return {
      index,
      newStart: prev === undefined ? 1 : prev.newEnd + 1,
      newEnd: span.newStart - 1,
      delta: span.oldStart - span.newStart,
    }
  })
  // 途中で省略したファイルは最後の hunk の後ろが本当の末尾ではないので、末尾の展開は出さない
  const last = known.at(-1)
  if (last !== undefined && !file.isTruncated) {
    gaps.push({ index: known.length, newStart: last.newEnd + 1, newEnd: file.source.length, delta: last.oldEnd - last.newEnd })
  }
  return gaps
}

export const expansionKey = (path: string, index: number): string => `${path}\u0000${index}`

export type RevealedGap = { top: DiffReviewRow[]; bottom: DiffReviewRow[]; hidden: number }

// 隠れた範囲のうち、上 (前の hunk の続き) と下 (次の hunk の手前) から開いた行を差分のない行として返す
export const revealGap = (gap: DiffReviewGap, source: readonly string[], expansion: DiffReviewExpansion | undefined): RevealedGap => {
  const size = Math.max(0, gap.newEnd - gap.newStart + 1)
  const top = Math.min(size, expansion?.top ?? 0)
  const bottom = Math.min(size - top, expansion?.bottom ?? 0)
  const row = (newNo: number): DiffReviewRow => {
    const text = source[newNo - 1] ?? ''
    return { left: { kind: 'ctx', no: newNo + gap.delta, text }, right: { kind: 'ctx', no: newNo, text } }
  }
  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i))
  return {
    top: range(gap.newStart, top),
    bottom: range(gap.newEnd - bottom + 1, bottom),
    hidden: size - top - bottom,
  }
}
