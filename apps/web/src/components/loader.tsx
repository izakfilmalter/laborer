import { Loader2 } from 'lucide-react'

export default function Loader() {
  return (
    <div className="flex h-full items-center justify-center pt-8">
      <span className="inline-flex animate-spin">
        <Loader2 />
      </span>
    </div>
  )
}
