import './TableScroll.css'

export default function TableScroll({ label, className = '', children }) {
  return <div className={`table-scroll ${className}`.trim()} role="region" aria-label={label} tabIndex={0}>{children}</div>
}
