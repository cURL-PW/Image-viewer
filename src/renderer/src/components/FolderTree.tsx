import { useState } from 'react'
import type { FolderNode } from '@shared/types'
import { useStore } from '../store'

interface NodeProps {
  node: FolderNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
}

function TreeNode({ node, depth, expanded, toggle }: NodeProps): React.JSX.Element {
  const dir = useStore((state) => state.dir)
  const setDir = useStore((state) => state.setDir)

  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.path)
  const isSelected = dir === node.path

  return (
    <li>
      <div
        className={`tree__row${isSelected ? ' tree__row--selected' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => setDir(node.path)}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isOpen : undefined}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setDir(node.path)
          }
        }}
      >
        <button
          type="button"
          className={`tree__caret${hasChildren ? '' : ' tree__caret--empty'}`}
          onClick={(event) => {
            event.stopPropagation()
            if (hasChildren) toggle(node.path)
          }}
          tabIndex={-1}
          aria-hidden={!hasChildren}
        >
          {hasChildren ? (isOpen ? '▾' : '▸') : ''}
        </button>
        <span className="tree__name" title={node.path || '/'}>
          {node.name}
        </span>
        <span className="tree__count">{node.count.toLocaleString()}</span>
      </div>
      {hasChildren && isOpen && (
        <ul className="tree__children">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function FolderTree(): React.JSX.Element {
  const tree = useStore((state) => state.tree)
  const recursive = useStore((state) => state.recursive)
  const setRecursive = useStore((state) => state.setRecursive)
  // ルートは既定で開いておく
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))

  const toggle = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <section className="panel panel--tree">
      <header className="panel__header">
        <h2>フォルダ</h2>
        <label className="panel__toggle" title="選択フォルダの配下も含めて表示する">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(event) => setRecursive(event.target.checked)}
          />
          サブフォルダ
        </label>
      </header>
      <div className="panel__body">
        {tree ? (
          <ul className="tree" role="tree">
            <TreeNode node={tree} depth={0} expanded={expanded} toggle={toggle} />
          </ul>
        ) : (
          <p className="panel__placeholder">ライブラリを追加してください</p>
        )}
      </div>
    </section>
  )
}
