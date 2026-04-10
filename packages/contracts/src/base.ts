import { Schema } from 'effect'

export const TrimmedString = Schema.Trimmed
export const TrimmedNonEmptyString = Schema.NonEmptyTrimmedString
export const PositiveInt = Schema.Int.pipe(Schema.greaterThanOrEqualTo(1))
export const NonNegativeInt = Schema.NonNegativeInt
export const IsoDateTime = Schema.String

const makeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand))

export const ProjectId = makeId('ProjectId')
export type ProjectId = typeof ProjectId.Type
export const makeProjectId = (value: string): ProjectId => value as ProjectId

export const ThreadId = makeId('ThreadId')
export type ThreadId = typeof ThreadId.Type
export const makeThreadId = (value: string): ThreadId => value as ThreadId
