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
  isGenerated: boolean
  hunks: DiffReviewHunk[]
  // 差分のない行を展開するための変更後のファイルの中身。読めないファイルは null
  source?: string[] | null
}

export type DiffReviewSnapshot = {
  baseLabel: string
  // 比較元に選べるブランチ (新しくコミットされた順)
  branches?: string[]
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

// hunk の間に隠れた行のうち、上から開いた行数と下から開いた行数
export type DiffReviewExpansion = {
  top: number
  bottom: number
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
      showGenerated: boolean
      // expansionKey(path, hunk の番号) ごとの展開状態
      expanded: Record<string, DiffReviewExpansion>
      // branch モードの比較元。null なら origin の既定ブランチ
      baseBranch: string | null
    }
  }
}
