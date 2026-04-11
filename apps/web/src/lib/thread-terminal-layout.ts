import { DEFAULT_TERMINAL_ID } from '@laborer/contracts/terminal'
import { useEffect, useMemo, useState } from 'react'

export interface WorkspaceTerminalGroup {
  readonly id: string
  terminalIds: string[]
}

export interface WorkspaceTerminalLayout {
  readonly activeTerminalGroupId: string
  readonly activeTerminalId: string
  readonly terminalGroups: WorkspaceTerminalGroup[]
  readonly terminalIds: string[]
}

interface StoredLayouts {
  readonly [workspaceId: string]: WorkspaceTerminalLayout | undefined
}

const STORAGE_KEY = 'laborer.terminal-layout:v2'
export const MAX_TERMINALS_PER_GROUP = 4

const defaultGroupId = (terminalId: string) => `group-${terminalId}`

const createDefaultLayout = (): WorkspaceTerminalLayout => ({
  activeTerminalGroupId: defaultGroupId(DEFAULT_TERMINAL_ID),
  activeTerminalId: DEFAULT_TERMINAL_ID,
  terminalGroups: [
    {
      id: defaultGroupId(DEFAULT_TERMINAL_ID),
      terminalIds: [DEFAULT_TERMINAL_ID],
    },
  ],
  terminalIds: [DEFAULT_TERMINAL_ID],
})

const copyGroups = (
  groups: readonly WorkspaceTerminalGroup[]
): WorkspaceTerminalGroup[] =>
  groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }))

const normalizeTerminalIds = (terminalIds: readonly string[]): string[] => {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter(Boolean))]
  return ids.length > 0 ? ids : [DEFAULT_TERMINAL_ID]
}

const findGroupIndexByTerminalId = (
  terminalGroups: readonly WorkspaceTerminalGroup[],
  terminalId: string
): number =>
  terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId))

const assignUniqueGroupId = (groupId: string, usedGroupIds: Set<string>) => {
  if (!usedGroupIds.has(groupId)) {
    usedGroupIds.add(groupId)
    return groupId
  }

  let suffix = 2
  while (usedGroupIds.has(`${groupId}-${suffix}`)) {
    suffix += 1
  }

  const uniqueGroupId = `${groupId}-${suffix}`
  usedGroupIds.add(uniqueGroupId)
  return uniqueGroupId
}

const normalizeLayout = (
  layout: WorkspaceTerminalLayout
): WorkspaceTerminalLayout => {
  const terminalIds = normalizeTerminalIds(layout.terminalIds)
  const validTerminalIdSet = new Set(terminalIds)
  const assignedTerminalIds = new Set<string>()
  const usedGroupIds = new Set<string>()
  const terminalGroups: WorkspaceTerminalGroup[] = []

  for (const group of layout.terminalGroups) {
    const nextTerminalIds = [
      ...new Set(group.terminalIds.map((id) => id.trim()).filter(Boolean)),
    ].filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) {
        return false
      }

      if (assignedTerminalIds.has(terminalId)) {
        return false
      }

      assignedTerminalIds.add(terminalId)
      return true
    })

    if (nextTerminalIds.length === 0) {
      continue
    }

    terminalGroups.push({
      id: assignUniqueGroupId(
        group.id.trim() ||
          defaultGroupId(nextTerminalIds[0] ?? DEFAULT_TERMINAL_ID),
        usedGroupIds
      ),
      terminalIds: nextTerminalIds,
    })
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) {
      continue
    }

    terminalGroups.push({
      id: assignUniqueGroupId(defaultGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    })
  }

  const activeTerminalId = terminalIds.includes(layout.activeTerminalId)
    ? layout.activeTerminalId
    : (terminalIds[0] ?? DEFAULT_TERMINAL_ID)
  const activeTerminalGroupId =
    terminalGroups.find((group) => group.id === layout.activeTerminalGroupId)
      ?.id ??
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))
      ?.id ??
    terminalGroups[0]?.id ??
    defaultGroupId(activeTerminalId)

  return {
    activeTerminalGroupId,
    activeTerminalId,
    terminalGroups,
    terminalIds,
  }
}

const isDefaultLayout = (layout: WorkspaceTerminalLayout): boolean => {
  const normalized = normalizeLayout(layout)
  const defaultLayout = createDefaultLayout()

  return JSON.stringify(normalized) === JSON.stringify(defaultLayout)
}

const updateLayouts = (
  layouts: StoredLayouts,
  workspaceId: string,
  updater: (layout: WorkspaceTerminalLayout) => WorkspaceTerminalLayout
): StoredLayouts => {
  if (workspaceId.trim().length === 0) {
    return layouts
  }

  const current = normalizeLayout(layouts[workspaceId] ?? createDefaultLayout())
  const next = normalizeLayout(updater(current))

  if (JSON.stringify(current) === JSON.stringify(next)) {
    return layouts
  }

  if (isDefaultLayout(next)) {
    const { [workspaceId]: _removed, ...rest } = layouts
    return rest
  }

  return {
    ...layouts,
    [workspaceId]: next,
  }
}

const readStoredLayouts = (): StoredLayouts => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as StoredLayouts
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

const persistLayouts = (layouts: StoredLayouts) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts))
  } catch {
    // Ignore storage write failures in private browsing / quota pressure.
  }
}

const splitLayout = (
  layout: WorkspaceTerminalLayout,
  terminalId: string,
  mode: 'new' | 'split'
): WorkspaceTerminalLayout => {
  const normalized = normalizeLayout(layout)
  if (terminalId.trim().length === 0) {
    return normalized
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId)
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds
  const terminalGroups = copyGroups(normalized.terminalGroups)

  const existingGroupIndex = findGroupIndexByTerminalId(
    terminalGroups,
    terminalId
  )
  if (existingGroupIndex >= 0) {
    const existingGroup = terminalGroups[existingGroupIndex]
    if (!existingGroup) {
      return normalized
    }

    existingGroup.terminalIds = existingGroup.terminalIds.filter(
      (id) => id !== terminalId
    )

    if (existingGroup.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1)
    }
  }

  if (mode === 'new') {
    const nextGroupId = assignUniqueGroupId(
      defaultGroupId(terminalId),
      new Set(terminalGroups.map((group) => group.id))
    )

    terminalGroups.push({
      id: nextGroupId,
      terminalIds: [terminalId],
    })

    return normalizeLayout({
      activeTerminalGroupId: nextGroupId,
      activeTerminalId: terminalId,
      terminalGroups,
      terminalIds,
    })
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId
  )
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(
      terminalGroups,
      normalized.activeTerminalId
    )
  }
  if (activeGroupIndex < 0) {
    const fallbackId = assignUniqueGroupId(
      defaultGroupId(normalized.activeTerminalId),
      new Set(terminalGroups.map((group) => group.id))
    )
    terminalGroups.push({
      id: fallbackId,
      terminalIds: [normalized.activeTerminalId],
    })
    activeGroupIndex = terminalGroups.length - 1
  }

  const destinationGroup = terminalGroups[activeGroupIndex]
  if (!destinationGroup) {
    return normalized
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(
      normalized.activeTerminalId
    )

    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId)
    } else {
      destinationGroup.terminalIds.push(terminalId)
    }
  }

  return normalizeLayout({
    activeTerminalGroupId: destinationGroup.id,
    activeTerminalId: terminalId,
    terminalGroups,
    terminalIds,
  })
}

const closeLayoutTerminal = (
  layout: WorkspaceTerminalLayout,
  terminalId: string
): WorkspaceTerminalLayout => {
  const normalized = normalizeLayout(layout)
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized
  }

  const remainingTerminalIds = normalized.terminalIds.filter(
    (id) => id !== terminalId
  )
  if (remainingTerminalIds.length === 0) {
    return createDefaultLayout()
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId)
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[
          Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)
        ] ??
        remainingTerminalIds[0] ??
        DEFAULT_TERMINAL_ID)
      : normalized.activeTerminalId

  const terminalGroups = normalized.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0)

  return normalizeLayout({
    activeTerminalGroupId:
      terminalGroups.find((group) =>
        group.terminalIds.includes(nextActiveTerminalId)
      )?.id ??
      terminalGroups[0]?.id ??
      defaultGroupId(nextActiveTerminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    terminalIds: remainingTerminalIds,
  })
}

export const createTerminalId = (): string =>
  `terminal-${crypto.randomUUID().slice(0, 8)}`

export const useWorkspaceTerminalLayout = (workspaceId: string | null) => {
  const [layouts, setLayouts] = useState<StoredLayouts>(() =>
    readStoredLayouts()
  )

  useEffect(() => {
    persistLayouts(layouts)
  }, [layouts])

  const resolvedWorkspaceId = workspaceId ?? ''
  const layout = useMemo(
    () =>
      normalizeLayout(layouts[resolvedWorkspaceId] ?? createDefaultLayout()),
    [layouts, resolvedWorkspaceId]
  )

  const update = (
    updater: (layout: WorkspaceTerminalLayout) => WorkspaceTerminalLayout
  ) => {
    setLayouts((current) =>
      updateLayouts(current, resolvedWorkspaceId, updater)
    )
  }

  return {
    closeTerminal: (terminalId: string) =>
      update((current) => closeLayoutTerminal(current, terminalId)),
    layout,
    newTerminal: (terminalId: string) =>
      update((current) => splitLayout(current, terminalId, 'new')),
    setActiveTerminal: (terminalId: string) =>
      update((current) => {
        const normalized = normalizeLayout(current)
        if (!normalized.terminalIds.includes(terminalId)) {
          return normalized
        }

        return {
          ...normalized,
          activeTerminalGroupId:
            normalized.terminalGroups.find((group) =>
              group.terminalIds.includes(terminalId)
            )?.id ?? normalized.activeTerminalGroupId,
          activeTerminalId: terminalId,
        }
      }),
    splitTerminal: (terminalId: string) =>
      update((current) => splitLayout(current, terminalId, 'split')),
  }
}
