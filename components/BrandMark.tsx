export function BrandMark({ size = 39 }: { size?: number }) {
  return <span className="brand-mark" style={{ width: size, height: size }}><img src="/logo.png" alt="" /></span>;
}
