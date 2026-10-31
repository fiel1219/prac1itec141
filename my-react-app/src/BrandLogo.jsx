import './Brand.css'

export default function BrandLogo({ className = '' }) {
  return <img className={`brand-logo ${className}`.trim()} src="/inventoscan-logo-192.png" width="40" height="40" alt="VSU InventoScan logo" decoding="async" />
}
