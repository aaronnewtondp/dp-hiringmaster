/**
 * Minimal ambient declaration for pdfmake's server-side Node API.
 *
 * pdfmake (0.2.23, as installed here) does NOT ship its own .d.ts files and
 * there is no @types/pdfmake package installed — `node_modules/pdfmake` has
 * no `types`/`typings` field and no `interfaces.d.ts`. Without this file,
 * `import PdfPrinter from 'pdfmake'` fails to typecheck (TS7016) under this
 * project's `strict: true` tsconfig. This declares just enough of the shape
 * we actually use (see src/services/pdf/longFormJd.ts, socialJd.ts) — content
 * node definitions are intentionally typed as `any`/loose objects rather than
 * a full port of pdfmake's TDocumentDefinitions/Content union, which would be
 * a large undertaking for marginal benefit given the JS layer has no types to
 * check against either.
 */
declare module 'pdfmake' {
  export interface PdfMakeFontDescriptor {
    normal: string;
    bold?: string;
    italics?: string;
    bolditalics?: string;
  }

  export type PdfMakeFonts = Record<string, PdfMakeFontDescriptor>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PdfMakeContent = any;

  export interface PdfMakeDocDefinition {
    content: PdfMakeContent;
    pageSize?: string | { width: number; height: number };
    pageOrientation?: 'portrait' | 'landscape';
    pageMargins?: number | [number, number] | [number, number, number, number];
    defaultStyle?: Record<string, unknown>;
    styles?: Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    header?: PdfMakeContent | ((currentPage: number, pageCount: number, pageSize: { width: number; height: number }) => PdfMakeContent);
    footer?: PdfMakeContent | ((currentPage: number, pageCount: number, pageSize: { width: number; height: number }) => PdfMakeContent);
    background?: PdfMakeContent | ((currentPage: number, pageSize: { width: number; height: number }) => PdfMakeContent);
    info?: Record<string, string>;
    compress?: boolean;
    [key: string]: unknown;
  }

  export default class PdfPrinter {
    constructor(fonts: PdfMakeFonts);
    createPdfKitDocument(
      docDefinition: PdfMakeDocDefinition,
      options?: Record<string, unknown>
    ): PDFKit.PDFDocument;
  }
}
