/** Slack's documented hard bound for one Markdown message projection. */
export const SLACK_MARKDOWN_TEXT_CODE_POINT_LIMIT = 12_000;

export const slackCodePointLength = (value: string): number =>
  [...value].length;
