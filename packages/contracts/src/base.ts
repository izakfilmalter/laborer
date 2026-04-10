import { Schema } from 'effect'

export const TrimmedString = Schema.Trim
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty())
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const IsoDateTime = Schema.String

const makeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand))

export const ProjectId = makeId('ProjectId')
export type ProjectId = typeof ProjectId.Type
export const makeProjectId = (value: string): ProjectId => value as ProjectId

export const ThreadId = makeId('ThreadId')
export type ThreadId = typeof ThreadId.Type
export const makeThreadId = (value: string): ThreadId => value as ThreadId
