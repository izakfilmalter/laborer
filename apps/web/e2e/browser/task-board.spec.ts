import { rm } from 'node:fs/promises'
import type { Locator, Page } from '@playwright/test'
import { Effect } from 'effect'
import {
  type DaemonFixture,
  expect,
  test,
} from '../fixtures/browser-fixtures.js'
import { initRepo } from '../fixtures/git-fixture.js'

interface BoardJourney {
  readonly projectId: string
  readonly taskId: string | null
  readonly tempRoots: readonly string[]
}

const seedBoardJourney = async (
  daemon: DaemonFixture,
  label: string,
  taskTitle?: string
): Promise<BoardJourney> => {
  const tempRoots: string[] = []
  const repoPath = initRepo(`board-${label}`, tempRoots)
  const seeded = await daemon.rpc.run((client) =>
    Effect.gen(function* () {
      const project = yield* client['project.add']({ repoPath })
      const task = taskTitle
        ? yield* client['task.create']({
            projectId: project.id,
            status: 'todo',
            text: taskTitle,
          })
        : null
      return { project, task }
    })
  )

  return {
    projectId: seeded.project.id,
    taskId: seeded.task?.id ?? null,
    tempRoots,
  }
}

const cleanBoardJourney = async (
  daemon: DaemonFixture,
  journey: BoardJourney
): Promise<void> => {
  try {
    await daemon.rpc.run((client) =>
      client['project.remove']({ projectId: journey.projectId }).pipe(
        Effect.asVoid
      )
    )
  } finally {
    for (const root of journey.tempRoots) {
      await rm(root, { force: true, recursive: true })
    }
  }
}

const openBoard = async (page: Page): Promise<Locator> => {
  const board = page.getByTestId('task-board')
  if (!(await board.isVisible())) {
    await page.getByRole('button', { name: 'Open board' }).click()
  }
  await expect(board).toBeVisible()
  return board
}

const laneFor = (board: Locator, projectId: string): Locator =>
  board.locator(
    `[data-testid="task-board-lane"][data-project-id="${projectId}"]`
  )

const columnFor = (lane: Locator, status: string): Locator =>
  lane.locator(`[data-testid="task-board-column"][data-status="${status}"]`)

const cardFor = (column: Locator, taskId: string): Locator =>
  column.locator(`[data-testid="task-board-card"][data-task-id="${taskId}"]`)

test.describe('task board and kanban journeys', () => {
  test('creates, edits, moves, and reloads a task', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const journey = await seedBoardJourney(daemon, 'lifecycle')

    try {
      const board = await openBoard(page)
      const lane = laneFor(board, journey.projectId)
      await expect(lane).toBeVisible({ timeout: 30_000 })
      const todo = columnFor(lane, 'todo')
      await todo.getByRole('button', { name: 'Add card to Todo' }).click()
      const composer = todo.getByRole('textbox', {
        name: 'Card title or Slack message link for Todo',
      })
      const initialTitle = `Board journey ${crypto.randomUUID()}`
      await composer.fill(initialTitle)
      await composer.press('Enter')

      const created = todo
        .getByTestId('task-board-card')
        .filter({ hasText: initialTitle })
      await expect(created).toBeVisible()
      const taskId = await created.getAttribute('data-task-id')
      expect(taskId).not.toBeNull()
      if (taskId === null) {
        throw new Error('Created task did not expose its durable identity')
      }

      await created
        .getByRole('button', { name: `Edit ${initialTitle}` })
        .click()
      const detail = page.getByTestId('task-detail-dialog')
      await expect(detail).toBeVisible()
      const editedTitle = `${initialTitle} edited`
      await detail.getByLabel('Title').fill(editedTitle)
      await detail
        .getByLabel('Description')
        .fill('Persist this description through the daemon.')
      await detail.getByRole('button', { name: 'Save changes' }).click()
      await expect(detail).toBeHidden()

      const edited = cardFor(todo, taskId)
      await expect(edited).toContainText(editedTitle)
      await expect(edited.getByLabel('Has description')).toBeVisible()

      const inReview = columnFor(lane, 'in_review')
      const sourceBox = await edited.boundingBox()
      const targetBox = await inReview
        .getByRole('button', { name: 'Add the first card to In Review' })
        .boundingBox()
      expect(sourceBox).not.toBeNull()
      expect(targetBox).not.toBeNull()
      if (!(sourceBox && targetBox)) {
        throw new Error('Task drag landmarks were not measurable')
      }
      await page.mouse.move(
        sourceBox.x + sourceBox.width / 2,
        sourceBox.y + sourceBox.height / 2
      )
      await page.mouse.down()
      await page.mouse.move(
        sourceBox.x + sourceBox.width / 2 + 20,
        sourceBox.y + sourceBox.height / 2,
        { steps: 4 }
      )
      await page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps: 20 }
      )
      await page.mouse.up()
      await expect(cardFor(inReview, taskId)).toContainText(editedTitle)
      await expect(cardFor(todo, taskId)).toHaveCount(0)

      await page.reload()
      await expect(page.getByTestId('mission-control')).toBeVisible({
        timeout: 30_000,
      })
      const reloadedBoard = await openBoard(page)
      const reloadedCard = cardFor(
        columnFor(laneFor(reloadedBoard, journey.projectId), 'in_review'),
        taskId
      )
      await expect(reloadedCard).toContainText(editedTitle, {
        timeout: 30_000,
      })
      await expect(reloadedCard.getByLabel('Has description')).toBeVisible()
    } finally {
      await cleanBoardJourney(daemon, journey)
    }
  })

  test('surfaces a detail CAS conflict without corrupting the winning task', async ({
    app: _app,
    daemon,
    page,
  }) => {
    const originalTitle = `Conflict journey ${crypto.randomUUID()}`
    const journey = await seedBoardJourney(
      daemon,
      'detail-conflict',
      originalTitle
    )

    try {
      expect(journey.taskId).not.toBeNull()
      if (journey.taskId === null) {
        throw new Error('Seeded task did not expose its durable identity')
      }
      const taskId = journey.taskId
      const board = await openBoard(page)
      const todo = columnFor(laneFor(board, journey.projectId), 'todo')
      const card = cardFor(todo, taskId)
      await expect(card).toBeVisible({ timeout: 30_000 })
      await card.getByRole('button', { name: `Edit ${originalTitle}` }).click()

      const detail = page.getByTestId('task-detail-dialog')
      const draftDescription = 'Keep this losing draft intact.'
      const losingTitle = `${originalTitle} losing draft`
      await detail.getByLabel('Title').fill(losingTitle)
      await detail.getByLabel('Description').fill(draftDescription)
      await daemon.rpc.run((client) =>
        client['task.move']({
          expectedRevision: 1,
          operationId: `e2e-conflict-${crypto.randomUUID()}`,
          sortOrder: null,
          status: 'in_review',
          taskId,
        })
      )

      await expect(detail.getByRole('alert')).toContainText(
        'This card changed elsewhere'
      )
      await detail.getByRole('button', { name: 'Save changes' }).click()

      await expect(detail).toBeVisible()
      await expect(detail.getByRole('alert')).toContainText(
        'changed elsewhere while saving'
      )
      await expect(detail.getByLabel('Title')).toHaveValue(losingTitle)
      await expect(detail.getByLabel('Description')).toHaveValue(
        draftDescription
      )
      await expect(page.getByTestId('toast-region')).toContainText(
        'Card changed elsewhere'
      )

      await page.reload()
      await expect(page.getByTestId('mission-control')).toBeVisible({
        timeout: 30_000,
      })
      const reloadedBoard = await openBoard(page)
      await expect(
        cardFor(
          columnFor(laneFor(reloadedBoard, journey.projectId), 'in_review'),
          taskId
        )
      ).toContainText(originalTitle, { timeout: 30_000 })
    } finally {
      await cleanBoardJourney(daemon, journey)
    }
  })
})
