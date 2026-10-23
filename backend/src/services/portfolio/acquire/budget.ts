// WORKER-ONLY. Hard ceilings for one marketing work-sample review. Every reserve*() is SYNCHRONOUS on purpose:
// fetchers run several at a time, and a check-then-act across an await would let two of them both pass the same cap.
export const BUDGET = {
  maxItems:           8,
  maxRawBytes:        18 * 1024 * 1024,   // ~24 MB once base64-encoded, under the 32 MB request limit
  maxFileBytes:       8 * 1024 * 1024,
  maxImageBytes:      5 * 1024 * 1024,
  maxPdfPagesTotal:   40,
  maxPdfPagesPerFile: 20,
  maxImages:          16,
  maxCharsPerItem:    12_000,
  maxCharsTotal:      60_000,
  fetchConcurrency:   4,
  perItemMs:          20_000,
  fetchPhaseMs:       45_000,
  maxSites:           2,
  siteMs:             70_000,
  acquireMs:          180_000,             // leaves ~90s of the 270s job budget for the model call
  estInputTokenCap:   100_000,
} as const;

export type BudgetLimits = { -readonly [K in keyof typeof BUDGET]: number };

export class BudgetTracker {
  private bytes = 0;
  private pages = 0;
  private images = 0;
  private chars = 0;

  constructor(private readonly limits: BudgetLimits = { ...BUDGET }) {}

  /** Reserves raw bytes for one downloaded file. False = it would break the per-file or total cap (nothing reserved). */
  reserveBytes(n: number): boolean {
    // NaN (e.g. a malformed content-length) would pass every comparison below and turn the counter into NaN for good;
    // a negative size would rewind it. Neither is a size.
    if (!(n >= 0)) return false;
    if (n > this.limits.maxFileBytes || this.bytes + n > this.limits.maxRawBytes) return false;
    this.bytes += n;
    return true;
  }

  /** Grants up to `want` PDF pages (never more than the per-file or total cap allows). Returns how many were granted. */
  reservePages(want: number): number {
    if (!(want > 0)) return 0;   // NaN and negatives grant nothing; they must not poison or rewind the counter
    const granted = Math.max(0, Math.min(want, this.limits.maxPdfPagesPerFile, this.limits.maxPdfPagesTotal - this.pages));
    this.pages += granted;
    return granted;
  }

  /** Grants up to `want` images. Returns how many were granted. */
  reserveImages(want: number): number {
    if (!(want > 0)) return 0;
    const granted = Math.max(0, Math.min(want, this.limits.maxImages - this.images));
    this.images += granted;
    return granted;
  }

  /** Grants up to `want` characters of extracted text (per-item cap, then the total cap). Returns how many were granted. */
  reserveChars(want: number): number {
    if (!(want > 0)) return 0;
    const granted = Math.max(0, Math.min(want, this.limits.maxCharsPerItem, this.limits.maxCharsTotal - this.chars));
    this.chars += granted;
    return granted;
  }

  snapshot(): { bytes: number; pages: number; images: number; chars: number } {
    return { bytes: this.bytes, pages: this.pages, images: this.images, chars: this.chars };
  }

  /** Rough input-token estimate for what has been reserved (pages × 2.5K, images × 1.5K, chars ÷ 3.5). */
  estimatedInputTokens(): number {
    return Math.round(this.pages * 2500 + this.images * 1500 + this.chars / 3.5);
  }
}
