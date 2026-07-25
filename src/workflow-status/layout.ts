import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { WorkflowStatusTheme, WorkflowStatusThemeColor } from './types.ts';

/** Clamp wrapped rows and mark the final visible row as truncated. */
export function clampRows(
  lines: ReadonlyArray<string>,
  maximum: number,
  width: number,
  theme: WorkflowStatusTheme,
): Array<string> {
  if (lines.length <= maximum) return [...lines];
  const visible = lines.slice(0, maximum);
  const last = visible.at(-1) ?? '';
  return visible.map((line, index) =>
    index === maximum - 1
      ? truncateToWidth(last, Math.max(1, width - 1), '', true) +
        theme.fg('dim', '…')
      : line,
  );
}

/** Render a wrapping label/value pair within a fixed visible width. */
export function keyValueLines(
  theme: WorkflowStatusTheme,
  label: string,
  rawValue: string,
  width: number,
  valueColor: WorkflowStatusThemeColor = 'text',
): Array<string> {
  const safeWidth = Math.max(1, width);
  const labelWidth = Math.min(10, Math.max(7, label.length + 1));
  const valueWidth = Math.max(1, safeWidth - labelWidth);
  const value = theme.fg(valueColor, rawValue.replace(/\s+/g, ' ').trim());
  const wrapped = wrapTextWithAnsi(value, valueWidth);
  const prefix = theme.fg('muted', label.padEnd(labelWidth));
  return (wrapped.length > 0 ? wrapped : ['']).map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${' '.repeat(labelWidth)}${line}`,
  );
}

/** Wrap content in a Unicode box constrained to a fixed width. */
export function boxed(
  theme: WorkflowStatusTheme,
  title: string,
  width: number,
  content: ReadonlyArray<string>,
  color: WorkflowStatusThemeColor = 'borderMuted',
): Array<string> {
  const safeWidth = Math.max(8, Math.floor(width));
  const bodyWidth = Math.max(1, safeWidth - 4);
  const topLabel = `╭─ ${title} `;
  const top = `${topLabel}${'─'.repeat(
    Math.max(0, safeWidth - visibleWidth(topLabel) - 1),
  )}╮`;
  const bottom = `╰${'─'.repeat(Math.max(0, safeWidth - 2))}╯`;
  const body = content.length > 0 ? content : [''];
  return [
    theme.fg(color, top),
    ...body.map(
      (line) =>
        `${theme.fg(color, '│')} ${padAnsi(
          truncateToWidth(line, bodyWidth),
          bodyWidth,
        )} ${theme.fg(color, '│')}`,
    ),
    theme.fg(color, bottom),
  ];
}

/** Join two independently boxed panels row-by-row. */
export function joinPanels(
  left: ReadonlyArray<string>,
  leftWidth: number,
  right: ReadonlyArray<string>,
  rightWidth: number,
  gap: number,
): Array<string> {
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => {
    const leftLine = padAnsi(left[index] ?? '', leftWidth);
    const rightLine = padAnsi(right[index] ?? '', rightWidth);
    return `${leftLine}${' '.repeat(gap)}${rightLine}`;
  });
}

/** Join left and right text into one fixed-width status row. */
export function joinColumns(
  left: string,
  right: string,
  width: number,
  leftWidth: number,
): string {
  const safeLeftWidth = Math.max(1, Math.min(leftWidth, width - 2));
  const rightWidth = Math.max(1, width - safeLeftWidth - 1);
  return `${padAnsi(
    truncateToWidth(left, safeLeftWidth),
    safeLeftWidth,
  )} ${truncateToWidth(right, rightWidth)}`;
}

/** Pad ANSI-styled text to a target visible width. */
export function padAnsi(value: string, width: number): string {
  const visible = visibleWidth(value);
  return visible >= width ? value : `${value}${' '.repeat(width - visible)}`;
}
