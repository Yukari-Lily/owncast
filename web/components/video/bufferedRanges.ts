export type BufferedRange = {
  start: number;
  end: number;
};

export const isTimeBuffered = (time: number, ranges: BufferedRange[] = []): boolean =>
  ranges.some(({ start, end }) => time > start && time < end);
