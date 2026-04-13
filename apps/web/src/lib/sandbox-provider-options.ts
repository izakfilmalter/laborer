import { Cloud, Container, Server } from 'lucide-react'

type SandboxProviderType = 'docker' | 'daytona' | 'shuru'

interface SandboxProviderOption {
  readonly description: string
  readonly Icon: typeof Container
  readonly label: string
  readonly value: SandboxProviderType
}

const SANDBOX_PROVIDER_OPTIONS: readonly SandboxProviderOption[] = [
  {
    label: 'Docker',
    value: 'docker',
    description: 'Local containers via OrbStack',
    Icon: Container,
  },
  {
    label: 'Daytona',
    value: 'daytona',
    description: 'Cloud sandboxes',
    Icon: Cloud,
  },
  {
    label: 'Shuru',
    value: 'shuru',
    description: 'Local microVM sandboxes',
    Icon: Server,
  },
] as const

export { SANDBOX_PROVIDER_OPTIONS }
export type { SandboxProviderOption, SandboxProviderType }
