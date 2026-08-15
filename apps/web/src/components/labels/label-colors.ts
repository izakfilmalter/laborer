/**
 * Label color tokens are the durable vocabulary (see `@laborer/shared/labels`);
 * Tailwind needs literal class strings, so the token -> class mapping lives
 * here on the renderer side.
 */

import { LABEL_COLORS, labelColorForName } from '@laborer/shared/labels'
import type { LabelColor } from '@laborer/shared/rpc'

/** A stored color a build older or newer than this one may not know. */
const isLabelColor = (value: string): value is LabelColor =>
  (LABEL_COLORS as readonly string[]).includes(value)

const LABEL_COLOR_DOT_CLASSES: Record<LabelColor, string> = {
  amber: 'bg-amber-500',
  blue: 'bg-blue-500',
  emerald: 'bg-emerald-500',
  orange: 'bg-orange-500',
  pink: 'bg-pink-500',
  red: 'bg-red-500',
  teal: 'bg-teal-500',
  violet: 'bg-violet-500',
}

/** The dot class for a specific color token, for color pickers. */
export const labelColorDotClassName = (color: LabelColor): string =>
  LABEL_COLOR_DOT_CLASSES[color]

/**
 * A label's colored-dot class, falling back to the name-derived color when a
 * stored token is not one this build knows.
 */
export const labelDotClassName = (label: {
  readonly color: string
  readonly name: string
}): string =>
  LABEL_COLOR_DOT_CLASSES[
    isLabelColor(label.color) ? label.color : labelColorForName(label.name)
  ]
