/**
 * Role Closure Summary PDF — a 1-page retrospective generated once a role
 * reaches Closed – Filled or Closed – Cancelled (CEO directive, 2026-08-29).
 * Deliberately much simpler than the long-form JD renderer (longFormJd.ts):
 * this is an internal report, not a candidate-facing branded document, so it
 * skips the bordered navy header/footer band entirely and just uses plain
 * page margins — reuses LONG_JD_COLORS for basic brand-consistent accent
 * colors only.
 */
import PdfPrinter from 'pdfmake';
import { LONG_JD_COLORS as C } from './theme.js';

export interface ClosureSummaryData {
  role: {
    id: string; title: string; department: string | null; hiring_manager_name: string | null;
    priority: string; location: string | null; employment_type: string | null; status: string;
    start_date: string | null; target_closure_date: string | null; closed_date: string | null;
    days_to_close: number | null; num_openings: number;
  };
  totalApplications: number;
  outcomes: { active: number; joined: number; rejected: number; withdrawn: number; hold_for_future: number };
  funnel: Array<{ stage: string; active: number; rejected: number; withdrawn: number; hold_for_future: number; joined: number }>;
  slaBreaches: { total: number; byType: Array<{ type: string; count: number }> };
  sourceQuality: Array<{ source_channel: string; n: number; pass_rate: number; hire_rate: number }>;
  velocity: { interview_to_offer_ratio: number | null; biggest_drop_off: { stage: string; count: number } | null };
  timeToFillDays: number | null;
}

const fonts = {
  Helvetica: {
    normal: 'Helvetica', bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique',
  },
};

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statLine(label: string, value: string | number): object {
  return {
    columns: [
      { text: label, width: 110, fontSize: 8, color: C.muted },
      { text: String(value), fontSize: 8, bold: true, color: C.text },
    ],
    margin: [0, 1, 0, 1],
  };
}

function sectionTitle(title: string): object {
  return {
    text: title.toUpperCase(),
    fontSize: 9, bold: true, color: C.navy,
    margin: [0, 8, 0, 3],
    decoration: 'underline', decorationColor: C.teal,
  };
}

export async function renderRoleClosureSummary(data: ClosureSummaryData): Promise<Buffer> {
  const printer = new PdfPrinter(fonts);
  const { role } = data;

  const funnelTableBody = [
    [
      { text: 'Stage', bold: true, fontSize: 7.5 },
      { text: 'Active', bold: true, fontSize: 7.5, alignment: 'right' },
      { text: 'Joined', bold: true, fontSize: 7.5, alignment: 'right' },
      { text: 'Rejected', bold: true, fontSize: 7.5, alignment: 'right' },
      { text: 'Withdrawn', bold: true, fontSize: 7.5, alignment: 'right' },
      { text: 'On Hold', bold: true, fontSize: 7.5, alignment: 'right' },
    ],
    ...data.funnel
      .filter(f => f.active + f.joined + f.rejected + f.withdrawn + f.hold_for_future > 0)
      .map(f => [
        { text: f.stage, fontSize: 7.5 },
        { text: String(f.active), fontSize: 7.5, alignment: 'right' },
        { text: String(f.joined), fontSize: 7.5, alignment: 'right' },
        { text: String(f.rejected), fontSize: 7.5, alignment: 'right' },
        { text: String(f.withdrawn), fontSize: 7.5, alignment: 'right' },
        { text: String(f.hold_for_future), fontSize: 7.5, alignment: 'right' },
      ]),
  ];

  const slaTableBody = data.slaBreaches.byType.length
    ? [
        [{ text: 'Breach type', bold: true, fontSize: 7.5 }, { text: 'Count', bold: true, fontSize: 7.5, alignment: 'right' }],
        ...data.slaBreaches.byType.map(t => [
          { text: t.type, fontSize: 7.5 },
          { text: String(t.count), fontSize: 7.5, alignment: 'right' },
        ]),
      ]
    : null;

  const sourceTableBody = data.sourceQuality.length
    ? [
        [
          { text: 'Source', bold: true, fontSize: 7.5 }, { text: 'Applied', bold: true, fontSize: 7.5, alignment: 'right' },
          { text: 'Pass %', bold: true, fontSize: 7.5, alignment: 'right' }, { text: 'Hire %', bold: true, fontSize: 7.5, alignment: 'right' },
        ],
        ...data.sourceQuality.map(s => [
          { text: s.source_channel, fontSize: 7.5 },
          { text: String(s.n), fontSize: 7.5, alignment: 'right' },
          { text: `${s.pass_rate}%`, fontSize: 7.5, alignment: 'right' },
          { text: `${s.hire_rate}%`, fontSize: 7.5, alignment: 'right' },
        ]),
      ]
    : null;

  const content: object[] = [
    // Header
    {
      columns: [
        { text: role.title, fontSize: 15, bold: true, color: C.navy },
        { text: role.id, fontSize: 9, color: C.muted, alignment: 'right' },
      ],
    },
    { text: `Role Closure Summary — ${role.status}`, fontSize: 9, color: C.teal, bold: true, margin: [0, 1, 0, 6] },

    // Role details — two-column key facts
    {
      columns: [
        {
          width: '50%',
          stack: [
            statLine('Department', role.department || '—'),
            statLine('Hiring Manager', role.hiring_manager_name || '—'),
            statLine('Priority', role.priority),
            statLine('Location', role.location || '—'),
          ],
        },
        {
          width: '50%',
          stack: [
            statLine('Openings', role.num_openings),
            statLine('Opened', fmtDate(role.start_date)),
            statLine('Closed', fmtDate(role.closed_date)),
            statLine('Days to close', role.days_to_close != null ? `${role.days_to_close}d` : '—'),
          ],
        },
      ],
    },

    sectionTitle('Final outcome'),
    {
      columns: [
        statLine('Total applications', data.totalApplications),
        statLine('Joined', data.outcomes.joined),
        statLine('Rejected', data.outcomes.rejected),
      ],
    },
    {
      columns: [
        statLine('Withdrawn', data.outcomes.withdrawn),
        statLine('Hold for Future', data.outcomes.hold_for_future),
        statLine('Still Active', data.outcomes.active),
      ],
    },

    sectionTitle('Pipeline funnel — every candidate who ever reached each stage'),
    {
      table: { widths: ['*', 40, 40, 45, 50, 40], body: funnelTableBody },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => C.border },
    },

    sectionTitle('SLA breaches'),
    slaTableBody
      ? {
          columns: [
            { width: '35%', stack: [statLine('Total breaches', data.slaBreaches.total)] },
            { width: '65%', table: { widths: ['*', 40], body: slaTableBody }, layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => C.border } },
          ],
        }
      : { text: 'No SLA breaches recorded for this role.', fontSize: 8, color: C.muted },

    sectionTitle('Source quality'),
    sourceTableBody
      ? { table: { widths: ['*', 40, 40, 40], body: sourceTableBody }, layout: { hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => C.border } }
      : { text: 'No sourced applications recorded for this role.', fontSize: 8, color: C.muted },

    sectionTitle('Operational velocity'),
    {
      columns: [
        // "->" not "→" — the arrow glyph isn't in WinAnsiEncoding, which is
        // all PDFKit's base-14 Helvetica supports without embedding a full
        // Unicode font; it rendered as mojibake when this was a real arrow.
        statLine('Interview -> Offer ratio', data.velocity.interview_to_offer_ratio != null ? `${data.velocity.interview_to_offer_ratio}%` : '—'),
        statLine('Time to fill', data.timeToFillDays != null ? `${data.timeToFillDays}d` : '—'),
        statLine('Biggest drop-off', data.velocity.biggest_drop_off ? `${data.velocity.biggest_drop_off.stage} (${data.velocity.biggest_drop_off.count})` : '—'),
      ],
    },
  ];

  const docDefinition = {
    pageSize: 'A4' as const,
    pageMargins: [36, 36, 36, 36] as [number, number, number, number],
    defaultStyle: { font: 'Helvetica', fontSize: 8.5, color: C.text },
    info: { title: `${role.title} — Closure Summary`, author: 'DigitalPaani HMS' },
    content,
  };

  const pdfDoc = printer.createPdfKitDocument(docDefinition);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}
