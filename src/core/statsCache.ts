let statsCacheVersion = 0;

export function getStatsCacheVersion(): number {
  return statsCacheVersion;
}

export function invalidateStatsCache(): void {
  statsCacheVersion += 1;
}
