/**
 * Named role + content fixtures for the social JD template — used by the unit
 * tests and by scripts/previewSocialJd.ts to eyeball the layout. `R019` is the
 * reference design exactly as shipped; the rest are deliberately awkward inputs
 * the layout has to survive (everything after the role block adapts to the role).
 */
import { Role } from '../../types/index.js';
import { JdContent } from '../jdContent.js';

export interface SocialFixture { role: Role; content: JdContent }

const role = (r: Partial<Role> & { title: string }): Role => ({ id: 'R999', ...r } as Role);
const content = (c: Partial<JdContent>): JdContent => ({
  tags: [], socialAboutRole: [], socialAboutYou: [], ...c,
} as unknown as JdContent);

const blue = (...t: string[]) => t.map(text => ({ text, isGreen: false }));
const green = (...t: string[]) => t.map(text => ({ text, isGreen: true }));

export const SOCIAL_FIXTURES: Record<string, SocialFixture> = {
  // The reference design (Head of Marketing & Creative Direction, as shipped 2026-10-22; the work-setup line was added 2026-10-26).
  R019: {
    role: role({ id: 'R019', title: 'Head of Marketing & Creative Direction', location: 'Gurgaon', department: 'Sales & Growth', yoe_required: '5-10 years' }),
    content: content({
      socialWorkSetup: 'Remote working possible for exceptional candidates',
      tags: [
        ...blue('Brand Building', 'Campaign Strategy', 'Creative Direction', 'Copywriting', 'Visual Design'),
        ...green('Climate/Sustainability', 'B2B Marketing', 'Video Production'),
      ],
      socialAboutRole: [
        "<b>Write the story:</b> DigitalPaani's narrative, from zero",
        '<b>Own every surface:</b> Brand, campaigns, creative direction',
        '<b>Build the team:</b> Hire and lead, with real autonomy',
        "<b>Early stage:</b> A presence the world can't ignore",
        '<b>Take on a crisis:</b> Water scarcity touching billions',
      ],
      socialAboutYou: [
        '<b>Built a brand:</b> From scratch, at a startup',
        '<b>Led campaigns:</b> 5+ launched, with real results',
        '<b>Write, design, lead:</b> Copy, visuals, and team leadership',
        '<b>Care about the mission:</b> Climate, water, social impact',
        '<b>Scrappy operator:</b> Startup DNA, limited resources',
      ],
    }),
  },

  // 46-char title with a hyphen and a "+": must split cleanly and shrink to fit.
  LONG_TITLE: {
    role: role({ title: 'Data Engineer-IoT Intelligence + ETL Pipelines', location: 'Gurgaon / Remote', department: 'Tech / Engineering', yoe_required: '3+ Years' }),
    content: content({
      tags: [...blue('Python', 'Kafka', 'Airflow', 'SQL'), ...green('Time-series', 'IoT', 'AWS')],
      socialAboutRole: [
        '<b>Build pipelines:</b> Sensor data in, insight out',
        '<b>Own data quality:</b> Every reading trusted',
        '<b>Scale ingestion:</b> From 100 to 1,000 sites',
        '<b>Ship weekly:</b> Small team, real impact',
        '<b>Partner with ML:</b> Feed the models that matter',
      ],
      socialAboutYou: [
        '<b>Built ETL at scale:</b> Production, not notebooks',
        '<b>Strong in SQL:</b> And one orchestration tool',
        '<b>Streaming experience:</b> Kafka or similar',
        '<b>Curious about water:</b> Or willing to learn',
        '<b>Own your work:</b> End to end',
      ],
    }),
  },

  // One-line title, no location, "Fresher" instead of a year range.
  SHORT_TITLE: {
    role: role({ title: 'Operations Associate', department: 'Operations', yoe_required: 'Fresher' }),
    content: content({
      tags: [...blue('Operations', 'Excel', 'Coordination'), ...green('Field Work')],
      socialAboutRole: [
        '<b>Run the day:</b> Keep sites moving',
        '<b>Track everything:</b> Reports that are right',
        '<b>Coordinate:</b> Vendors, teams, deadlines',
      ],
      socialAboutYou: [
        '<b>Organised:</b> Details do not slip',
        '<b>Clear communicator:</b> Hindi and English',
        '<b>Ready to travel:</b> Sites across India',
      ],
    }),
  },

  // Content as the OLD generator wrote it: abstract labels, descriptions up to ~90 chars.
  LEGACY_BULLETS: {
    role: role({ title: 'Sr. Backend Developer', location: 'Gurgaon', department: 'Tech / Engineering', yoe_required: '4-8 years' }),
    content: content({
      tags: [...blue('Node.js', 'TypeScript', 'PostgreSQL', 'AWS'), ...green('IoT', 'Time-series', 'Kubernetes')],
      socialAboutRole: [
        '<b>Mission:</b> Architect the backend that runs water infrastructure across the country at scale',
        '<b>Scope:</b> APIs, data pipelines, and cloud deployment across all products',
        '<b>Team:</b> Join a small senior engineering team with real autonomy',
        '<b>Stage:</b> Early startup—build the foundations that everything else will sit on',
        '<b>Impact:</b> Water scarcity crisis affecting billions of people globally',
      ],
      socialAboutYou: [
        '<b>Backend expert:</b> 4+ years building production Node.js and TypeScript systems',
        '<b>Database skills:</b> Strong PostgreSQL schema design and query optimisation',
        '<b>Systems thinker:</b> Design for reliability, observability and scale',
        '<b>Mission-driven:</b> Passion for climate, water, and social impact',
        '<b>Scrappy operator:</b> Execute with limited resources, startup DNA',
      ],
    }),
  },

  // 12 long tags: must pack into two rows and drop the overflow rather than grow a third row.
  MANY_TAGS: {
    role: role({ title: 'Senior Product Manager', location: 'Gurgaon', department: 'Product', yoe_required: '6-10 years' }),
    content: content({
      tags: [
        ...blue('Product Strategy', 'Roadmapping', 'User Research', 'Stakeholder Management', 'Data-Driven Decisions', 'B2B SaaS', 'Agile Delivery'),
        ...green('Climate/Sustainability', 'IoT Platforms', 'Enterprise Sales Support', 'Analytics', 'Hardware-Software Products'),
      ],
      socialAboutRole: [
        '<b>Own the roadmap:</b> What we build and why',
        '<b>Talk to users:</b> Plant operators, every week',
        '<b>Define success:</b> Metrics that matter',
        '<b>Ship with eng:</b> Tight loops, no theatre',
        '<b>Sell the vision:</b> To leadership and buyers',
      ],
      socialAboutYou: [
        '<b>Shipped products:</b> 0 to 1 and 1 to 10',
        '<b>Technical enough:</b> To debate trade-offs',
        '<b>Data fluent:</b> SQL and dashboards',
        '<b>Great writer:</b> Specs people actually read',
        '<b>Mission first:</b> Water, climate, impact',
      ],
    }),
  },

  // Sparse: nothing but a title and a few bullets — no tags, no location/experience/team.
  SPARSE: {
    role: role({ title: 'Field Engineer' }),
    content: content({
      tags: [],
      socialAboutRole: ['<b>Commission sites:</b> Install and tune', '<b>Fix fast:</b> Be the person on call', '<b>Report clearly:</b> Photos and notes'],
      socialAboutYou: ['<b>Hands-on:</b> Electrical or instrumentation', '<b>Willing to travel:</b> Most weeks'],
    }),
  },

  // WORK SETUP is hand-authored and optional (R019 carries it above). A Location this long widens the first column until the
  // sentence would be cut, so TEAM is the item that goes (it is logged) and the sentence takes the full width of row 1.
  WORK_SETUP_LONG_LOCATION: {
    role: role({ title: 'Senior UX/Product Designer', location: 'Hyderabad, Bangalore', department: 'Design', yoe_required: '5-8 years' }),
    content: content({
      socialWorkSetup: 'Remote working possible for exceptional candidates',
      tags: [...blue('Product Design', 'Prototyping', 'User Research'), ...green('IoT Dashboards')],
      socialAboutRole: ['<b>Design the product:</b> From plant floor to boardroom', '<b>Run research:</b> Operators, every week', '<b>Own the system:</b> Components and patterns'],
      socialAboutYou: ['<b>Shipped products:</b> Real users, real data', '<b>Strong craft:</b> Figma and beyond', '<b>Systems thinker:</b> Consistency at scale'],
    }),
  },

  // Three items: no Team. The sentence shares row 1's full width, set on two lines.
  WORK_SETUP_NO_TEAM: {
    role: role({ title: 'Brand Designer', location: 'Gurgaon', yoe_required: '3-6 years' }),
    content: content({
      socialWorkSetup: 'Hybrid: three days a week in the Gurgaon office',
      tags: [...blue('Brand Design', 'Illustration', 'Motion'), ...green('B2B')],
      socialAboutRole: ['<b>Shape the brand:</b> Every surface, every format', '<b>Make it move:</b> Short video and motion', '<b>Keep it consistent:</b> One system, many channels'],
      socialAboutYou: ['<b>A strong portfolio:</b> Brand work that shipped', '<b>Fast and careful:</b> Both, always', '<b>Team player:</b> Works with marketing and sales'],
    }),
  },

  // A hyphenated word that is 227pt wide at full size, in a 204pt column: it must never be drawn past the card. The sentence is
  // set at the smaller size at which every line fits (Team stays). R019's own wording is not affected.
  WORK_SETUP_LONG_WORD: {
    role: role({ title: 'Head of Marketing & Creative Direction', location: 'Gurgaon', department: 'Sales & Growth', yoe_required: '5-10 years' }),
    content: content({
      socialWorkSetup: 'Work-from-anywhere possible',
      tags: [...blue('Brand Building', 'Copywriting'), ...green('B2B Marketing')],
      socialAboutRole: ['<b>Write the story:</b> From zero', '<b>Own every surface:</b> Brand and campaigns', '<b>Build the team:</b> Hire and lead'],
      socialAboutYou: ['<b>Built a brand:</b> From scratch', '<b>Led campaigns:</b> 5+ launched', '<b>Write, design, lead:</b> All three'],
    }),
  },

  // A long Team beside the sentence: it cannot be set in its half even at the smallest size, so it is left out (logged), not cut.
  WORK_SETUP_LONG_TEAM: {
    role: role({ title: 'Business Operations Lead', location: 'Gurgaon', department: 'Corporate Functions/Business Operations', yoe_required: '6-9 years' }),
    content: content({
      socialWorkSetup: 'Remote working possible for exceptional candidates',
      tags: [...blue('Operations', 'Process Design'), ...green('Utilities')],
      socialAboutRole: ['<b>Run the machine:</b> Finance to field', '<b>Fix the process:</b> Where it hurts', '<b>Report clearly:</b> To leadership'],
      socialAboutYou: ['<b>Ran operations:</b> At a growing company', '<b>Process minded:</b> Simple beats clever', '<b>Calm under load:</b> Always'],
    }),
  },

  // Nothing else in the block but a title and the sentence.
  WORK_SETUP_ONLY: {
    role: role({ title: 'Field Engineer' }),
    content: content({
      socialWorkSetup: 'Remote working possible for exceptional candidates',
      tags: [],
      socialAboutRole: ['<b>Commission sites:</b> Install and tune', '<b>Fix fast:</b> Be the person on call', '<b>Report clearly:</b> Photos and notes'],
      socialAboutYou: ['<b>Hands-on:</b> Electrical or instrumentation', '<b>Willing to travel:</b> Most weeks'],
    }),
  },

  // Longer than the 60-character cap: cut with an ellipsis, never silently, and still two lines in the column.
  WORK_SETUP_TOO_LONG: {
    role: role({ title: 'Head of Partnerships', location: 'Gurgaon', department: 'Sales & Growth', yoe_required: '8-12 years' }),
    content: content({
      socialWorkSetup: 'Remote working is possible for exceptional candidates who have led partnerships at scale before',
      tags: [...blue('Partnerships', 'Negotiation', 'Strategy'), ...green('Water Utilities')],
      socialAboutRole: ['<b>Open doors:</b> Utilities, industry, government', '<b>Close deals:</b> From first call to contract', '<b>Build the team:</b> Hire and lead'],
      socialAboutYou: ['<b>Led partnerships:</b> At scale, with results', '<b>Strong network:</b> In water or infrastructure', '<b>Great closer:</b> Patient and persistent'],
    }),
  },
};
