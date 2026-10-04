export type DiffReviewMode = 'branch' | 'uncommitted'

export type DiffReviewView = 'split' | 'unified'

export type DiffReviewCell = {
  kind: 'ctx' | 'add' | 'del'
  no: number
  text: string
}

export type DiffReviewRow = {
  left: DiffReviewCell | null
  right: DiffReviewCell | null
}

export type DiffReviewHunk = {
  header: string
  rows: DiffReviewRow[]
}

export type DiffReviewFile = {
  path: string
  oldPath: string
  added: number
  removed: number
  isBinary: boolean
  isUntracked: boolean
  isTruncated: boolean
  hunks: DiffReviewHunk[]
}

export type DiffReviewSnapshot = {
  baseLabel: string
  files: DiffReviewFile[]
  error: string | null
}

export type DiffReviewSide = 'L' | 'R'

// start..end の行範囲 (1行なら start === end)
export type DiffReviewRange = {
  path: string
  side: DiffReviewSide
  start: number
  end: number
}

// 行番号を押して選んでいる範囲。1回目のクリックは起点だけで、2回目で範囲が決まり入力欄が開く
export type DiffReviewTarget = DiffReviewRange & {
  isEditing: boolean
}

export type DiffReviewComment = DiffReviewRange & {
  id: string
  body: string
}

declare module 'claude-code' {
  interface PluginState {
    'diff-review': {
      mode: DiffReviewMode
      snapshot: DiffReviewSnapshot | null
      selected: string | null
      comments: DiffReviewComment[]
      target: DiffReviewTarget | null
      collapsed: string[]
      view: DiffReviewView
    }
  }
}
