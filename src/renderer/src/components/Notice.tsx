import { useEffect, useState } from 'react'
import { useStore } from '../store'

/** 通知を出しておく時間 (ms) */
const NOTICE_DURATION = 1800

/** 画面下に一瞬だけ出す通知。「コピーしました」など、操作の手応えを返すためのもの。 */
export default function Notice(): React.JSX.Element | null {
  const notice = useStore((state) => state.notice)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!notice) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), NOTICE_DURATION)
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice || !visible) return null
  return (
    <div className="notice" role="status">
      {notice.text}
    </div>
  )
}
