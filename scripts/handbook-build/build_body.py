#!/usr/bin/env python3
"""TubeForge Maintenance Handbook - body PDF (ReportLab, Report route).

Cover is rendered separately (Template 07 Crystal Blue via html2poster.js)
and merged as page 0 by merge_final.py.
All figures verified against the live repo at revision 42238f7 (2026-11-12).
"""
import os
import sys
import hashlib

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, Image, KeepTogether,
                                CondPageBreak, HRFlowable, Flowable)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from PIL import Image as PILImage

PDF_SKILL_DIR = '/home/z/my-project/skills/pdf'
sys.path.insert(0, os.path.join(PDF_SKILL_DIR, 'scripts'))
from pdf import install_font_fallback  # noqa: E402

BUILD = '/home/z/my-project/scripts/handbook-build'
OUT_BODY = os.path.join(BUILD, 'body.pdf')

# ------------------------------------------------------------------
# Fonts (allowed set only)
# ------------------------------------------------------------------
FONT_DIR = '/usr/share/fonts'
pdfmetrics.registerFont(TTFont('NotoSerifSC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSC-Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Noto Sans SC', f'{FONT_DIR}/truetype/chinese/NotoSansSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('Noto Sans SC Bold', f'{FONT_DIR}/truetype/chinese/NotoSansSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif', f'{FONT_DIR}/truetype/freefont/FreeSerif.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Bold', f'{FONT_DIR}/truetype/freefont/FreeSerifBold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Italic', f'{FONT_DIR}/truetype/freefont/FreeSerifItalic.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-BoldItalic', f'{FONT_DIR}/truetype/freefont/FreeSerifBoldItalic.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuSans', f'{FONT_DIR}/truetype/dejavu/DejaVuSansMono.ttf'))

registerFontFamily('NotoSerifSC', normal='NotoSerifSC', bold='NotoSerifSC-Bold')
registerFontFamily('Noto Sans SC', normal='Noto Sans SC', bold='Noto Sans SC Bold')
registerFontFamily('FreeSerif', normal='FreeSerif', bold='FreeSerif-Bold',
                   italic='FreeSerif-Italic', boldItalic='FreeSerif-BoldItalic')
registerFontFamily('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans')
install_font_fallback()

# ------------------------------------------------------------------
# Palette - Template 07 Crystal Blue body subset (fixed by the template)
# ------------------------------------------------------------------
PAGE_BG = colors.HexColor('#f5f8fc')       # XL
SECTION_BG = colors.HexColor('#edf2f9')    # XL
CARD_BG = colors.HexColor('#e4ecf5')       # L
TABLE_STRIPE = colors.HexColor('#eef3fa')  # L
HEADER_FILL = colors.HexColor('#1a4a7a')   # M
BORDER = colors.HexColor('#c0d0e2')        # S
ACCENT = colors.HexColor('#2d7ab3')        # XS
TEXT_PRIMARY = colors.HexColor('#142840')
TEXT_MUTED = colors.HexColor('#5a7a96')

TABLE_HEADER_COLOR = HEADER_FILL
TABLE_ROW_EVEN = colors.white
TABLE_ROW_ODD = TABLE_STRIPE

# ------------------------------------------------------------------
# Page geometry
# ------------------------------------------------------------------
PAGE_W, PAGE_H = A4
MARGIN = 0.85 * inch                      # symmetric left/right
TOP_MARGIN = 0.95 * inch
BOTTOM_MARGIN = 0.85 * inch
AVAIL_W = PAGE_W - 2 * MARGIN
AVAIL_H = PAGE_H - TOP_MARGIN - BOTTOM_MARGIN
H1_ORPHAN = AVAIL_H * 0.25
MAX_KEEP = PAGE_H * 0.4

DOC_TITLE = 'TubeForge Maintenance Handbook'
DOC_FOOT = 'ibis01/tubeforge  -  November 2026'

# ------------------------------------------------------------------
# Styles
# ------------------------------------------------------------------
S = {}
S['body'] = ParagraphStyle('Body', fontName='FreeSerif', fontSize=10.5,
                           leading=17, alignment=TA_JUSTIFY,
                           textColor=TEXT_PRIMARY, spaceBefore=0, spaceAfter=10)
S['lead'] = ParagraphStyle('Lead', parent=S['body'], fontSize=11, leading=18,
                           textColor=TEXT_PRIMARY)
S['h1'] = ParagraphStyle('H1', fontName='FreeSerif', fontSize=22, leading=27,
                         alignment=TA_LEFT, textColor=HEADER_FILL,
                         spaceBefore=0, spaceAfter=4)
S['h2'] = ParagraphStyle('H2', fontName='FreeSerif', fontSize=15, leading=20,
                         alignment=TA_LEFT, textColor=TEXT_PRIMARY,
                         spaceBefore=16, spaceAfter=8)
S['h3'] = ParagraphStyle('H3', fontName='FreeSerif', fontSize=11.5, leading=16,
                         alignment=TA_LEFT, textColor=TEXT_PRIMARY,
                         spaceBefore=12, spaceAfter=6)
S['cell'] = ParagraphStyle('Cell', fontName='FreeSerif', fontSize=9.2,
                           leading=13, alignment=TA_LEFT, textColor=TEXT_PRIMARY)
S['cellc'] = ParagraphStyle('CellC', parent=S['cell'], alignment=TA_CENTER)
S['cellh'] = ParagraphStyle('CellH', fontName='FreeSerif', fontSize=9.4,
                            leading=13, alignment=TA_LEFT,
                            textColor=colors.white)
S['cellhc'] = ParagraphStyle('CellHC', parent=S['cellh'], alignment=TA_CENTER)
S['caption'] = ParagraphStyle('Caption', fontName='FreeSerif', fontSize=8.5,
                              leading=12, alignment=TA_CENTER,
                              textColor=TEXT_MUTED, spaceBefore=0, spaceAfter=0)
S['code'] = ParagraphStyle('Code', fontName='DejaVuSans', fontSize=8.5,
                           leading=13, alignment=TA_LEFT,
                           textColor=TEXT_PRIMARY, leftIndent=10)
S['quote'] = ParagraphStyle('Quote', fontName='FreeSerif-Italic', fontSize=10.5,
                            leading=17, alignment=TA_LEFT, leftIndent=24,
                            textColor=TEXT_MUTED, spaceBefore=6, spaceAfter=10)
S['stat'] = ParagraphStyle('Stat', fontName='FreeSerif', fontSize=20,
                           leading=24, alignment=TA_CENTER, textColor=ACCENT)
S['statlabel'] = ParagraphStyle('StatLabel', fontName='FreeSerif', fontSize=9,
                                leading=12, alignment=TA_CENTER,
                                textColor=TEXT_MUTED)
S['toc0'] = ParagraphStyle('TOC0', fontName='FreeSerif', fontSize=11.5,
                           leading=21, leftIndent=6, textColor=TEXT_PRIMARY)
S['toctitle'] = ParagraphStyle('TOCTitle', fontName='FreeSerif', fontSize=22,
                               leading=27, textColor=HEADER_FILL, spaceAfter=14)

# ------------------------------------------------------------------
# Doc template with TOC support + page-number zones
# ------------------------------------------------------------------
class BodyStartMarker(Flowable):
    """Zero-height marker: records the page where the body (Chapter 1) starts."""
    def __init__(self):
        Flowable.__init__(self)
        self.width = 0
        self.height = 0

    def wrap(self, aw, ah):
        return (0, 0)

    def draw(self):
        pass


class TocDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, BodyStartMarker):
            self.body_start_page = self.page
        if hasattr(flowable, 'bookmark_name'):
            level = getattr(flowable, 'bookmark_level', 0)
            text = getattr(flowable, 'bookmark_text', '')
            key = getattr(flowable, 'bookmark_key', '')
            # TOC displays the footer numbering scheme: arabic, reset at the
            # body's first page (front matter is roman). Translate the internal
            # page index so "chapter 1 -> page 1" matches what the footer shows.
            display = self.page
            bs = getattr(self, 'body_start_page', None)
            if bs is not None and self.page >= bs:
                display = self.page - bs + 1
            self.notify('TOCEntry', (level, text, display, key))


ROMAN = {1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii',
         8: 'viii', 9: 'ix', 10: 'x'}


def on_page(canvas, doc):
    canvas.setFont('FreeSerif', 7.5)
    canvas.saveState()
    # Header: title left + accent rule
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, PAGE_H - 0.55 * inch, DOC_TITLE)
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1.2)
    canvas.line(MARGIN, PAGE_H - 0.63 * inch, PAGE_W - MARGIN, PAGE_H - 0.63 * inch)
    # Footer: light rule + author left + page number right
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 0.62 * inch, PAGE_W - MARGIN, 0.62 * inch)
    canvas.setFont('FreeSerif', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, 0.45 * inch, DOC_FOOT)
    body_start = getattr(doc, 'body_start_page', None)
    page = doc.page
    if body_start is not None and page >= body_start:
        label = str(page - body_start + 1)
    else:
        label = ROMAN.get(page, str(page))
    canvas.drawRightString(PAGE_W - MARGIN, 0.45 * inch, label)
    canvas.restoreState()


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def add_heading(text, style, level=0):
    key = 'h_%s' % hashlib.md5(text.encode()).hexdigest()[:8]
    p = Paragraph('<a name="%s"/><b>%s</b>' % (key, text), style)
    p.bookmark_name = key
    p.bookmark_level = level
    p.bookmark_text = text
    p.bookmark_key = key
    return p


def safe_keep_together(elements):
    total_h = 0
    for el in elements:
        w, h = el.wrap(AVAIL_W, PAGE_H)
        total_h += h
    if total_h <= MAX_KEEP:
        return [KeepTogether(elements)]
    elif len(elements) >= 2:
        return [KeepTogether(elements[:2])] + list(elements[2:])
    return list(elements)


def h1(story, text):
    """Chapter heading: conditional break, heading + accent rule."""
    head = add_heading(text, S['h1'], level=0)
    rule = HRFlowable(width='100%', thickness=1.4, color=ACCENT,
                      spaceBefore=0, spaceAfter=14)
    story.append(CondPageBreak(H1_ORPHAN))
    story.append(Spacer(1, 10))
    story.extend(safe_keep_together([head, rule]))


def h2(story, text):
    story.append(CondPageBreak(0.12 * AVAIL_H))
    story.append(add_heading_plain(text, S['h2']))


def add_heading_plain(text, style):
    return Paragraph('<b>%s</b>' % text, style)


def body(story, text, style='body'):
    story.append(Paragraph(text, S[style]))


def make_table(story, header, rows, ratios, caption=None, center_cols=(),
               font_size=None, keep_with_prev=False):
    """Standard handbook table. All cells wrapped in Paragraph()."""
    cell = S['cell'] if font_size is None else ParagraphStyle(
        'CellS%d' % font_size, parent=S['cell'], fontSize=font_size,
        leading=font_size + 3.8)
    cellc = ParagraphStyle('CellSC%d' % font_size, parent=cell, alignment=TA_CENTER) \
        if font_size else S['cellc']
    hstyle = S['cellh'] if font_size is None else ParagraphStyle(
        'CellHS%d' % font_size, parent=S['cellh'], fontSize=font_size + 0.2,
        leading=font_size + 4)
    hstylec = ParagraphStyle('CellHSC%d' % font_size, parent=hstyle,
                             alignment=TA_CENTER) if font_size else S['cellhc']

    data = [[Paragraph('<b>%s</b>' % h,
                       hstylec if i in center_cols else hstyle)
             for i, h in enumerate(header)]]
    for row in rows:
        data.append([Paragraph(str(c), cellc if i in center_cols else cell)
                     for i, c in enumerate(row)])

    widths = [r * AVAIL_W for r in ratios]
    assert abs(sum(ratios) - 1.0) < 0.01, 'ratios must sum to 1'
    assert sum(widths) <= AVAIL_W + 0.5, 'table exceeds available width'

    t = Table(data, colWidths=widths, hAlign='CENTER', repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, BORDER),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]
    for r in range(1, len(data)):
        style.append(('BACKGROUND', (0, r), (-1, r),
                      TABLE_ROW_ODD if r % 2 == 1 else TABLE_ROW_EVEN))
    t.setStyle(TableStyle(style))

    story.append(Spacer(1, 12))
    if caption:
        cap = Paragraph(caption, S['caption'])
        if len(rows) <= 15:
            story.extend(safe_keep_together([t, Spacer(1, 6), cap]))
        else:
            story.append(t)
            story.append(Spacer(1, 6))
            story.append(cap)
    else:
        if len(rows) <= 15:
            story.extend(safe_keep_together([t]))
        else:
            story.append(t)
    story.append(Spacer(1, 14))


def callout(story, stat, label):
    data = [[Paragraph('<b>%s</b>' % stat, S['stat'])],
            [Paragraph(label, S['statlabel'])]]
    t = Table(data, colWidths=[300], hAlign='CENTER')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), CARD_BG),
        ('BOX', (0, 0), (-1, -1), 1, ACCENT),
        ('TOPPADDING', (0, 0), (-1, 0), 12),
        ('BOTTOMPADDING', (0, -1), (-1, -1), 12),
        ('TOPPADDING', (0, 1), (-1, 1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 2),
        ('LEFTPADDING', (0, 0), (-1, -1), 14),
        ('RIGHTPADDING', (0, 0), (-1, -1), 14),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    story.append(Spacer(1, 8))
    story.extend(safe_keep_together([t]))
    story.append(Spacer(1, 12))


def code_block(story, lines, label=None):
    parts = []
    if label:
        parts.append(Paragraph(label, ParagraphStyle(
            'CodeLabel', parent=S['caption'], alignment=TA_LEFT,
            textColor=TEXT_MUTED, spaceAfter=4)))
    for ln in lines:
        parts.append(Paragraph(ln.replace(' ', ' '), S['code']))
    inner = Table([[p] for p in parts], colWidths=[AVAIL_W * 0.96], hAlign='CENTER')
    inner.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), SECTION_BG),
        ('LINEBEFORE', (0, 0), (0, -1), 2.4, ACCENT),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 1.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5),
        ('TOPPADDING', (0, 0), (-1, 0), 8),
        ('BOTTOMPADDING', (0, -1), (-1, -1), 8),
    ]))
    story.append(Spacer(1, 8))
    story.extend(safe_keep_together([inner]))
    story.append(Spacer(1, 12))


def embed_chart(story, path, caption, max_h=235):
    pil = PILImage.open(path)
    ow, oh = pil.size
    max_w = AVAIL_W * 0.96
    ratio = min(max_w / ow, max_h / oh, 1.0)
    img = Image(path, width=ow * ratio, height=oh * ratio)
    cap = Paragraph(caption, S['caption'])
    story.append(Spacer(1, 20))
    story.extend(safe_keep_together([img, Spacer(1, 8), cap]))
    story.append(Spacer(1, 20))


# ------------------------------------------------------------------
# Build
# ------------------------------------------------------------------
doc = TocDocTemplate(
    OUT_BODY, pagesize=A4,
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=TOP_MARGIN, bottomMargin=BOTTOM_MARGIN,
    title=DOC_TITLE, author='Z.ai', creator='Z.ai',
    subject='Maintenance handbook for the TubeForge multi-tenant AI video platform',
)

story = []

# ---- TOC page (front matter, roman numeral) ----
story.append(Paragraph('<b>Table of Contents</b>', S['toctitle']))
story.append(HRFlowable(width='100%', thickness=1.4, color=ACCENT,
                        spaceBefore=0, spaceAfter=16))
toc = TableOfContents()
toc.levelStyles = [S['toc0']]
story.append(toc)
story.append(PageBreak())
story.append(BodyStartMarker())

# =================================================================
# 1. System Overview & Repository Baseline
# =================================================================
h1(story, '1. System Overview and Repository Baseline')
body(story,
     'TubeForge is a multi-tenant AI video production platform. A user inside an '
     'organization moves from a script idea to a published video through AI-assisted '
     'scripting, storyboarding, casting, voiceover, rendering and publishing, all '
     'inside one product. The front end is a Next.js 16 App Router application '
     '(Zustand for state, TanStack Query for data); the back end is a Prisma-managed '
     'PostgreSQL database, a default-deny API surface of 123 route files, and an '
     'independent worker process that consumes a database-backed durable queue and '
     'runs the render pipeline. One Docker image serves both the web and worker '
     'processes in production.', 'lead')
body(story,
     'Repository state at the time of writing: <b>origin/main is ce7e9c3</b> with CI '
     'green on all six jobs and the unit suite at 471/471. Local HEAD is '
     '<b>42238f7</b>, two commits ahead of origin and not yet pushed (the development '
     'sandbox holds no TF_TOKEN credential). The delta is the boot-payload '
     'code-splitting fix described in Section 2.2 and Chapter 9. Every figure in this '
     'handbook was re-measured against the working tree at 42238f7 on 2026-11-12; '
     'where a repository document disagrees, Chapter 11 records the drift explicitly.')
make_table(story,
    ['Metric', 'Value at 42238f7'],
    [
        ['Source files under src/', '356'],
        ['Library modules (src/lib/tubeforge)', '132'],
        ['Provider layer files', '11'],
        ['API route files (src/app/api, route.ts)', '123'],
        ['Prisma models (schema.prisma)', '32'],
        ['Prisma migrations', '23'],
        ['Unit tests passing', '471 / 471'],
        ['Playwright e2e specifications', '7'],
        ['CI jobs (ci.yml) + nightly battery', '6 + 1'],
        ['Frontend views', '11 (1 eager + 10 lazy)'],
        ['Worklog session headers', '67 (S0 through S94)'],
        ['ROADMAP 2.0 items landed at v1', '13 / 13'],
    ],
    [0.62, 0.38], caption='Table 1 - Repository baseline, re-measured 2026-11-12.',
    center_cols=(1,))
embed_chart(story, os.path.join(BUILD, 'chart-boot.png'),
            'Figure 1 - Dev boot payload before and after the code-splitting fix '
            '(commit 42238f7), as measured by scripts/measure-boot.js.')
body(story,
     'How to read this handbook. Chapters 2 through 10 describe the system as it '
     'exists: architecture, data model, security, the job and render pipeline, the '
     'API surface, the provider matrix, testing, CI/CD, and deployment. Chapter 11 is '
     'the audit chapter: it lists every place where the repository documentation has '
     'drifted behind the code, together with the maintenance runbook and the standing '
     'risk register. Appendix A collects the commands, environment variables and '
     'document index a maintainer needs day to day.')

# =================================================================
# 2. Architecture
# =================================================================
h1(story, '2. Architecture')
h2(story, '2.1 Topology')
body(story,
     'The browser talks HTTPS to a Next.js 16 standalone server (Node 20), '
     'authenticating with either a session cookie or a scoped bearer API token. '
     'Inside the server, src/middleware.ts is a default-deny gatekeeper whose public '
     'allow-list contains exactly six auth endpoints plus the YouTube OAuth callback; '
     'everything else requires an authenticated, tenant-scoped request. The 123 API '
     'route files under src/app/api are tenant-scoped through async-local-storage '
     '(ALS): tenant-db.ts, a Prisma $extends client, injects the organizationId of '
     'the requesting membership into every query. The 132 modules of '
     'src/lib/tubeforge carry the domain logic, including the 11 provider files that '
     'wrap external AI services. A separate worker process (scripts/worker.mts) '
     'consumes the durable job queue in Postgres; Compose and Fly run web and worker '
     'from the same image.')
body(story,
     'Downstream of the app sit five dependencies: PostgreSQL (Prisma with versioned '
     'migrations), local disk or S3/R2-compatible object storage with presigned-URL '
     'delivery, the AI provider gateway (chat, TTS, image, video, ASR, vision), the '
     'YouTube Data API with OAuth for publishing and analytics, and the stock footage '
     'sources Pexels and Pixabay. The worker additionally needs ffmpeg and, for the '
     'whiteboard and 3D lanes, a headless Chromium (Chapter 5).')
h2(story, '2.2 Frontend: eleven views, one eager')
body(story,
     'The application surface is composed of eleven views: dashboard, create, '
     'library, cast, voice, research, channels, calendar, analytics, settings and '
     'world. Until revision 42238f7 the landing page statically imported all eleven, '
     'so a phone on a 4G connection could sit on the AuthGate splash ("Warming up '
     'the forge...") for minutes while roughly 10 MB of gzipped JavaScript arrived. '
     'The fix keeps the dashboard eager and streams the other ten views in on first '
     'visit; the loaders unwrap the named exports because the view files carry no '
     'default export. The dev boot payload fell from 9.84 MB to 5.12 MB gzipped '
     'across 34 to 20 assets (Figure 1), and scripts/measure-boot.js was added as '
     'the standing boot-payload diagnostic.')
make_table(story,
    ['View', 'What it owns'],
    [
        ['dashboard', 'Mission Control - the landing overview a user meets after the gate.'],
        ['create', 'The script-to-video creation flow.'],
        ['library', 'The video library and delivered cuts.'],
        ['cast', 'Characters, casting and appearance identity.'],
        ['voice', 'Voice profiles and voiceover synthesis.'],
        ['research', 'Research sessions and source material.'],
        ['channels', 'YouTube channels, publishing and analytics.'],
        ['calendar', 'The scheduling surface (ScheduleSlot).'],
        ['analytics', 'Video statistics and performance.'],
        ['settings', 'Account and organization settings, provider credentials, AI scoring.'],
        ['world', 'The world bible - locations and props (Stage 5).'],
    ],
    [0.20, 0.80],
    caption='Table 2 - The eleven frontend views under src/components/tubeforge/views.',
    font_size=8.8)
h2(story, '2.3 Process model and shared state')
body(story,
     'Web and worker are stateless relative to each other: all shared state lives in '
     'PostgreSQL (the job queue, the JSON document columns, usage and reservation '
     'records) and in object storage. That is what lets the Fly deployment scale the '
     'worker independently of the web tier, and what makes a crashed job resumable - '
     'the worker re-reads its payload from the database and continues '
     'deterministically. The optional voice server is the one component that wants a '
     'persistent box; it is addressed over HTTP and never shares memory with the app '
     '(Chapter 10).')
h2(story, '2.4 Current versus target architecture')
body(story,
     'ARCHITECTURE.md keeps two pictures: Section 1 is the current architecture, '
     'reconciled against the live source at S75 (2026-11-10), and Sections 2 through '
     '8 remain the target designs from the S47 era. The reconciliation that produced '
     'the current picture is recorded in docs/audits/s75-architecture-reconciliation-'
     'record.md. Since S75, the S88 through S94 slices landed without a fresh '
     'reconciliation - their design contracts live in docs/design/s84 through '
     'docs/design/s94 - which is the root cause of the documentation drift audited '
     'in Chapter 11.')

# =================================================================
# 3. Data Model & Migrations
# =================================================================
h1(story, '3. Data Model and Migrations')
h2(story, '3.1 The tenancy spine')
body(story,
     'The schema (prisma/schema.prisma) declares 32 models. The tenancy spine is '
     'User, Organization and Membership, with the four roles owner, admin, editor '
     'and viewer. Every content model carries an organizationId column with cascade '
     'delete and an index, so a tenant evacuation is one delete and isolation is '
     'structural, not conventional. Settings are per-user rows (UserSetting), never '
     'singletons, and provider credentials plus YouTube tokens are encrypted per '
     'record with AES-256-GCM under a v1. key format (Chapter 4).')
h2(story, '3.2 The 32 models at a glance')
make_table(story,
    ['Family', 'Models'],
    [
        ['Tenancy spine', 'User, Organization, Membership'],
        ['Access', 'Session, ApiToken, Setting, UserSetting, AuthAttempt'],
        ['Integrations', 'YouTubeAccount, ProviderCredential, Channel'],
        ['Creative core', 'Video, Character, CharacterAppearance, WhiteboardAssetUpload, VoiceProfile, MusicTrack, Location, Prop'],
        ['Operations', 'Job, Activity, ResearchSession, ScheduleSlot, VideoStat'],
        ['Billing and usage', 'StorageUsage, UsageRecord, SpendReservation, Plan, Subscription, CreditGrant, CreditLedger'],
        ['Integrity', 'ProcessedWebhookEvent (exactly-once webhook handling)'],
    ],
    [0.24, 0.76],
    caption='Table 3 - The 32 Prisma models grouped by family.', font_size=8.8)
h2(story, '3.3 The JSON document columns')
body(story,
     'The heavier creative state lives in versioned JSON document columns on Video '
     'rather than in wide relational tables. The docs follow one law set in the S88 '
     'era: versioned on write, tolerant on parse, strict on write, round-trip safe. '
     'The timeline document carries a schema stamp (1 or 2) with a guard that refuses '
     'to overwrite a document stamped by an unknown future version across all six '
     'write paths - the stale-tracks hazard is structurally impossible rather than '
     'policed. referenceAnalysis (S88) is the ninth such column and scene3d (S94) '
     'the tenth, with its own 3-pin contract: junk, version and empty payloads are '
     'refused, the round-trip is byte-stable, and the light law guarantees an ambient '
     'default so a scene never renders black.')
h2(story, '3.4 The 23 migrations')
body(story,
     'Twenty-three migrations are on record, one initial plus twenty-two feature '
     'migrations. Production ships them with prisma migrate deploy; local '
     'development uses the generated SQLite mirror (Section 3.5). The two most '
     'recent - s88_reference_analysis and s94_scene3d - postdate the S75 '
     'architecture reconciliation, which is why ARCHITECTURE.md still counts 22.')
make_table(story,
    ['Migration', 'What it introduced'],
    [
        ['000000000000_init', 'The Stage-1 baseline schema (11-model, single-user era).'],
        ['stage2_multiuser', 'User / Organization / Membership; organizationId on content models.'],
        ['stage3_queue', 'The durable job queue tables.'],
        ['stage3b_usage_storage', 'Usage records and storage accounting.'],
        ['stage3c_job_payload', 'Versioned job payload columns.'],
        ['stage5_director / _world / _sources', 'AI Director plan, world bible and source documents.'],
        ['stage6_publishing', 'Publishing and channel targets.'],
        ['stage7_billing (+ s71, s72_credit_reservations)', 'Billing, spend integrity, credit reservations.'],
        ['auth_setting', 'UserSetting rows (per-user settings).'],
        ['s20_api_token_registry', 'The 90-day scoped API token registry.'],
        ['s32_spend_reservations', 'Spend-gate reservation ledger.'],
        ['s40_qc_enforcement', 'QC enforcement records.'],
        ['s46_auth_attempt', 'AuthAttempt table backing login lockout.'],
        ['s49_content_policy', 'Per-org content policy.'],
        ['s67_whiteboard_doc / s69_whiteboard_assets', 'Whiteboard document and its asset rows.'],
        ['s72_retention_report', 'Retention reporting.'],
        ['s88_reference_analysis', 'referenceAnalysis - the ninth JSON doc column (S88).'],
        ['s94_scene3d', 'Video.scene3d - the tenth JSON doc column (S94).'],
    ],
    [0.40, 0.60],
    caption='Table 4 - The 23 Prisma migrations, grouped by the feature that shipped them.')
h2(story, '3.5 The SQLite mirror cannot drift')
body(story,
     'Production runs PostgreSQL; local development runs SQLite. There is exactly '
     'one source schema - prisma/schema.prisma - and the SQLite variant is generated '
     'from it by scripts/sync-sqlite-schema.mjs, then provisioned with prisma db '
     'push in the setup path. A hand-edited second schema is therefore impossible by '
     'construction; schema changes always ship as versioned migrations against the '
     'single source. The cost of the mirror is one extra script in the setup chain '
     '(npm run setup:local), the benefit is that a laptop developer and the '
     'production database agree by construction.')

# =================================================================
# 4. Multi-Tenancy, Auth & Security
# =================================================================
h1(story, '4. Multi-Tenancy, Authentication and Security')
h2(story, '4.1 Accounts and sessions')
body(story,
     'Passwords are stored as PBKDF2 hashes. Sessions are server-side Session rows - '
     'seven-day, individually revocable - behind signed cookies, so a logout or a '
     'compromise response is a row delete, not a wait for expiry. API access uses '
     '90-day scoped ApiToken bearer tokens from the s20 registry. Email verification '
     'and password reset are built in, and GDPR export and delete close the account '
     'lifecycle.')
h2(story, '4.2 The default-deny gate')
body(story,
     'src/middleware.ts denies everything by default. The public allow-list is six '
     'auth endpoints plus /api/youtube/callback; every other route requires an '
     'authenticated session or token. A production fail-safe refuses to serve at all '
     'when TUBEFORGE_AUTH_SECRET is missing - the failure mode is a down deployment, '
     'never an open one. Login lockout (S46) counts failures in a rolling ten-minute '
     'window per account, locks out after five, and persists through the AuthAttempt '
     'table; the check runs through a second Prisma client so a migration or a '
     'multi-instance roll can never leave it forgotten. The documented availability '
     'choice is that a lockout-read error fails open (announced, not silent).')
h2(story, '4.3 Tenant scoping in the data layer')
body(story,
     'The organizationId of the requesting membership is carried in the request '
     'context through async local storage. tenant-db.ts exposes a Prisma $extends '
     'client that injects that organizationId into queries, and raw imports of '
     '@/lib/db in route code are lint-blocked, so the scoping is not a convention a '
     'new endpoint can forget. Cross-tenant isolation is pinned end to end by '
     'e2e/isolation.spec.ts and by the per-stage route probes that run in CI.')
h2(story, '4.4 Secrets and request hygiene')
body(story,
     'Secrets at rest - ProviderCredential.apiKey and the YouTube tokens - are '
     'AES-256-GCM encrypted per record in a v1. envelope format, so a database dump '
     'alone does not yield provider keys. Mutations carry an origin check for CSRF '
     'atop SameSite=Lax cookies. Outbound fetches go through net-guard.ts safeFetch, '
     'which blocks private, loopback, CGNAT and cloud-metadata targets, re-resolves '
     'DNS per redirect hop to defeat rebinding, and caps both bytes and wall time. '
     'The S46 lesson generalizes: every security table is verified through its own '
     'Prisma client so infrastructure rolls cannot silently drop it.')

h2(story, '4.5 The security model at a glance')
make_table(story,
    ['Mechanism', 'Implementation', 'Pinned by'],
    [
        ['Password hashing', 'PBKDF2', 'Unit suite'],
        ['Sessions', '7-day, revocable Session rows behind signed cookies', 'Route probes'],
        ['API tokens', '90-day scoped ApiToken registry (s20)', 'Unit suite'],
        ['The gate', 'Default-deny middleware; 6 public auth endpoints + YouTube callback', 'Route battery'],
        ['Login lockout', '5 failures / rolling 10 min, AuthAttempt, second Prisma client', 'S46 records'],
        ['Secrets at rest', 'AES-256-GCM per record, v1. envelope', 'Crypto unit pins'],
        ['CSRF', 'Origin check on mutations + SameSite=Lax cookies', 'Route probes'],
        ['SSRF', 'safeFetch: private / loopback / CGNAT / metadata blocked, DNS re-resolved per hop, byte and time caps', 'net-guard tests'],
        ['Tenant scoping', 'tenant-db $extends ALS injection; raw @/lib/db lint-blocked', 'e2e isolation spec'],
    ],
    [0.20, 0.55, 0.25],
    caption='Table 5 - The security model, mechanism by mechanism.', font_size=8.6)

# =================================================================
# 5. Job System & Render Pipeline
# =================================================================
h1(story, '5. Job System and Render Pipeline')
h2(story, '5.1 The durable queue')
body(story,
     'Rendering is too slow and too failure-prone to run inside a request. Every '
     'long operation - renders, reference analysis, 3D scenes, critic runs - is a '
     'row in the Postgres job queue, consumed by scripts/worker.mts. Jobs are '
     'crash-resumable by design: the payload is versioned and deterministic '
     're-render on resume is the contract, so a worker restart mid-job costs time, '
     'not correctness. The queue ledger lesson from S88 is now standing practice: '
     'when a job kind is added, every kind ledger is updated in the same slice, '
     'which is how the S94 3D lane shipped both ledgers moving 23 to 24 kinds '
     'together.')
h2(story, '5.2 The render lanes')
body(story,
     'Four engines produce footage, all feeding the same timeline composition '
     'contract. The compositor lane renders image-backed scenes with kenburns and '
     'zoompan motion through ffmpeg. The whiteboard lane rasterizes frame plans in '
     'headless Chromium driven by Playwright, screenshotting frame by frame on a '
     'frame-quantized clock before ffmpeg assembly. The slides engine keeps its own '
     'browser path with the same launch discipline. The 3D lane (S94) renders '
     'three.js r187 scenes under WebGL 2.0 on SwiftShader inside the same proven '
     'Chromium pipeline - three\'s relative core import is resolved by dual blob '
     'injection - and the resulting clip rides the timeline as an ordinary '
     'video-kind asset: the compositor cannot tell it from stock footage, and must '
     'not. The character rig (S93) is a motion source, not a fifth pipeline: it '
     'emits zoompan-vocabulary plans for portrait-backed cast scenes with a breath '
     'cycle capped at three percent amplitude - "a whisper, never a punch" - and '
     'sits at the bottom of the per-shot seniority ladder.')
h2(story, '5.3 The Chromium worker contract')
body(story,
     'The production image must ship a browser or the whiteboard and 3D lanes die '
     'at chromium.launch(). The contract, measured in the S75 E10 benchmark and '
     'the E12 live queue drill: install Chromium in the runner stage with '
     'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright and npx playwright install '
     '--with-deps chromium (the pinned playwright 1.57.0 resolves browser build '
     'chromium-1200 from the image\'s own node_modules), and launch with '
     '--no-sandbox --disable-dev-shm-usage - encoded as WB_CHROMIUM_LAUNCH_ARGS in '
     'src/lib/tubeforge/whiteboard/render.ts and used at both launch sites. The '
     'measured reason: on a 4 GB worker with the default 64 MB /dev/shm, a bare '
     'launch is SIGKILLed mid-scene by the OOM killer. The Dockerfile lines have '
     'landed and the dependency closure is verified statically, but the image '
     'build itself has NOT been smoke-tested - the sandbox has no Docker daemon - '
     'and that smoke remains a required production gate (Chapter 11).')
h2(story, '5.4 The Universal Timeline contract (S87)')
body(story,
     'The timeline document is the spine every engine writes into. S87 closed the '
     'Universal Timeline contract at the code level across six slices: the version '
     'stamp, the v2 dual-write that derives tracks at serialization (a stale-tracks '
     'document is structurally impossible), the composition plan that dispatches '
     'per-scene on kind, the whiteboard lane emitting tracks on the one '
     'frame-quantized clock, the collapse of the legacy branches, and the '
     'acceptance battery. The battery (scripts/s87-acceptance-battery.mts) runs '
     'real renders through both engine lanes with zero AI spend, holds 18 of 18 '
     'checks, and is wired into the CI e2e job; its first run caught and fixed a '
     'real engine bug - a mixed-voiceover assembly crash in the whiteboard lane. '
     'One tail is recorded: the slice-4 soak gate, fourteen or more days with zero '
     'v1-document renders before the legacy fallback retires.')

h2(story, '5.5 The audio contract')
body(story,
     'The S76 close-out struck the synthetic-audio caveat from the whiteboard '
     'smoke and pinned the loudness contract at the engine boundary: loudness is '
     'measured and enforced where the audio is mixed, not policed per caller. The '
     'whiteboard lane carries the same voiceover interlock as the compositor - a '
     'render does not ship without its audio contract satisfied - and both lanes '
     'compose on the one frame-quantized clock, so a scene window is by '
     'construction the delivered frames for it. The S87 battery caught the last '
     'known audio edge: a mixed-voiceover assembly with partial voice coverage '
     'previously crashed the whiteboard render, and the fix is pinned by the '
     'battery rather than by a unit test alone.')

# =================================================================
# 6. API Surface
# =================================================================
h1(story, '6. API Surface (Route Map)')
body(story,
     'There are 123 route.ts files under src/app/api at 42238f7 - the S75 '
     'reconciliation recorded 116, and the S88 through S94 slices added the rest. '
     'The surface is uniform: every route is tenant-scoped through the ALS-injected '
     'Prisma client, every mutation carries the origin check, and the middleware '
     'gate in front of all of them is default-deny. The table below is the '
     'maintenance map - where to look when a surface changes, and what each area '
     'owns.')
make_table(story,
    ['Area', 'Representative endpoints', 'Notes'],
    [
        ['Auth (public)', 'login, register, verify, reset, session', 'The 6-endpoint public allow-list; everything else denies.'],
        ['Account / tokens', 'GET/POST/DELETE /api/tokens', '90-day scoped ApiToken registry (s20).'],
        ['Videos & scenes', '/api/videos, /api/videos/[id]/scenes', 'Script, storyboard, casting, assembly.'],
        ['Director & plan', '/api/videos/[id]/plan, /director', 'AI Director plan document and approvals.'],
        ['Voice & TTS', '/api/videos/[id]/voice', 'Voiceover synthesis and verification.'],
        ['Render', 'POST/GET /api/videos/[id]/render', 'Both engine lanes; kind-ledger dispatch.'],
        ['Stock', '/api/videos/[id]/stock', 'Pexels + Pixabay adapters, ranker, verifier (S89).'],
        ['Whiteboard', '/api/videos/[id]/whiteboard', 'Whiteboard document and assets (s67/s69).'],
        ['Reference (S88)', 'POST/GET/DELETE /api/videos/[id]/reference', 'Upload-only ingestion; crash-resumable analysis job.'],
        ['Scene3D (S94)', 'POST/GET/DELETE /api/videos/[id]/scene3d', '3D contract doc; deterministic re-render on resume.'],
        ['Board (S91)', 'GET /api/videos/[id]/board', 'One composed production snapshot; no new tables.'],
        ['Pacing (S92)', 'GET /api/videos/[id]/pacing', 'Measured words-per-minute strip; advisory only.'],
        ['AI score (S90)', 'GET/PUT /api/settings/ai/score', 'Provider scoring surface; advisory, never dispatch.'],
        ['YouTube', '/api/youtube/* (+ public callback)', 'OAuth publish and analytics.'],
        ['Billing & credits', '/api/billing, /api/credits', 'Spend gates, reservations, integrity checks.'],
        ['Admin & retention', '/api/admin/*', 'QC enforcement, content policy, retention reports.'],
    ],
    [0.20, 0.40, 0.40],
    caption='Table 6 - Route map by area. 123 route files total at 42238f7.',
    font_size=8.6)
body(story,
     'Two disciplines keep this surface honest. First, the kind ledgers: the job '
     'dispatch enumerates its kinds in more than one place, and the S88 CI failure '
     'taught that adding a job kind must move every ledger in the same slice - S94 '
     'did exactly that, 23 to 24 kinds in both. Second, the route battery: '
     'scripts/run-route-battery.mjs plus the per-stage route probes exercise the '
     'surface end to end in CI, so an endpoint that loses its scope or its gate '
     'fails a check rather than a tenant.')

# =================================================================
# 7. Providers & Intelligent Engines
# =================================================================
h1(story, '7. AI Providers and Intelligent Engines')
h2(story, '7.1 The provider layer')
body(story,
     'Eleven files under src/lib/tubeforge/providers wrap every external AI '
     'capability - chat, text-to-speech, image, video, ASR and vision - behind one '
     'registry with shared HTTP handling, configuration and per-user settings. The '
     'zai-video-core module carries the video gateway core. Because every call goes '
     'through the same seam, cross-cutting law (spend gates, SSRF guarding, usage '
     'recording) is written once.')
make_table(story,
    ['File', 'Responsibility'],
    [
        ['registry.ts', 'Provider registry; the single enumeration every consumer reads.'],
        ['config.ts / settings.ts', 'Provider configuration and per-user provider settings.'],
        ['http.ts', 'Shared HTTP client; timeouts, retries, byte caps.'],
        ['chat.ts', 'LLM chat completion (script, director, structure passes).'],
        ['tts.ts / asr.ts', 'Voice synthesis and speech-to-text.'],
        ['image.ts / vision.ts', 'Image generation and VLM judging.'],
        ['video.ts / zai-video-core.ts', 'Video generation and the gateway core.'],
    ],
    [0.34, 0.66],
    caption='Table 7 - The 11-file provider layer under src/lib/tubeforge/providers.')
h2(story, '7.2 Provider selection intelligence (S90)')
body(story,
     'provider-score.ts is a pure, advisory scoring engine. The production-calibrated '
     'weights are quality 30, reliability 25, cost 20, latency 10 and fit 15 - '
     'user-overridable through the ai.scoreWeights setting, tolerantly parsed, '
     'clamped, and all-zero-safe. The engine blends the organization\'s own '
     'UsageRecords into the priors Bayesian-style: success rate and mean latency '
     'score the reliability and latency factors, and failures count toward both '
     'reliability and the cost average. Two laws are pinned in tests: the '
     'unknown-pricing law - a paid provider with an unpriced model scores at the '
     'conservative fallback, never free, because free must be established by design '
     '(the gateway, self-hosting, or a no-key provider) - and the advisory-only '
     'law: dispatch reads the user\'s configured provider; the score explains, it '
     'never chooses.')
make_table(story,
    ['Band (words per minute)', 'Verdict', 'Role targets (S92)'],
    [
        ['Under 130', 'Dragging', 'Hook: 185 wpm'],
        ['130 - 175', 'Measured', 'Body: 155 wpm'],
        ['175 - 205', 'Brisk', 'Close: 150 wpm'],
        ['Over 205', 'Rushed', 'A brisk hook fits its role'],
    ],
    [0.36, 0.28, 0.36],
    caption='Table 8 - The narration pacing law (S92): bands measured from real '
            'scene audio, targets per beat role.', center_cols=(0, 1, 2))
h2(story, '7.3 The 2.0 intelligent systems')
body(story,
     'The TubeForge 2.0 track (ROADMAP items 4 through 13) layered intelligence '
     'onto the shared systems rather than forking pipelines. All thirteen items are '
     'landed at v1; the governing rule throughout was "shared contracts first, no '
     'parallel pipelines."')
make_table(story,
    ['System', 'Session', 'What v1 delivers'],
    [
        ['Visual Consistency Engine', 'S77-S83', 'Unified style engine, appearance dimension, repaint re-checks, shot-art locks, cross-video character identity, pose-level rows.'],
        ['Video Critic & Repair', 'S84-S86', 'Rendered-cut quality report (ship / hold / insufficient-evidence), the critic card, one-click repair firing the named affordance.'],
        ['Reference intelligence', 'S88', 'Upload-only ingestion, scene map + keyframes + ASR + VLM + LLM passes (fail-open), the copyright wall: structure to the prompt, never the transcript.'],
        ['Stock intelligence', 'S89', 'Pexels + Pixabay adapters, license-floored ranker, sequential frame verifier with early exit, the never-silent verification law.'],
        ['Provider selection', 'S90', 'The advisory scoring engine of Section 7.2.'],
        ['Production board', 'S91', 'One snapshot endpoint over existing tables: five stages, five approval checkpoints, 30-day costs, live polling.'],
        ['Narration pacing', 'S92', 'Measured scene WPM from real audio durations; English bands and role targets; advisory strip, never auto-resynthesis.'],
        ['Character rig', 'S93', 'Breath-cycle motion plans in the zoompan vocabulary, amplitude capped at 3%, stillness contract senior to the rig.'],
        ['3D engine', 'S94', 'three.js under SwiftShader through the whiteboard pipeline; the clip rides as an ordinary video-kind asset; Blender recorded as the offline exporter.'],
    ],
    [0.22, 0.12, 0.66],
    caption='Table 9 - The TubeForge 2.0 intelligent systems (all at v1).',
    center_cols=(1,), font_size=8.6)

# =================================================================
# 8. Testing & QA
# =================================================================
h1(story, '8. Testing and Quality Assurance')
h2(story, '8.1 The unit suite')
body(story,
     'The unit suite runs through scripts/test-unit.mts and stands at 471 passing, '
     'zero failing, at 42238f7. It grew by 27 tests across the last six ROADMAP '
     'sessions alone (Figure 2), because the standing practice is that every v1 '
     'lands with its contract pinned: the S89 stock work alone added 16 pins, and '
     'the S88 doc laws, copyright wall and pacing bands are all unit-pinned '
     'deterministically. Two further suites run separately and gate the same '
     'commit: the billing suite (scripts/test-billing.mts) and the queue suite; '
     'npm run check chains typecheck, lint, the unit suite and the billing suite '
     'into the one command a maintainer runs before pushing.')
callout(story, '471 / 471',
        'Unit tests passing at 42238f7 - plus the billing and queue suites, '
        '7 Playwright e2e specifications, and the 18-check S87 acceptance battery.')
embed_chart(story, os.path.join(BUILD, 'chart-tests.png'),
            'Figure 2 - Unit-test count across the closing 2.0 sessions, from the '
            'worklog receipts (S89 through S94).')
h2(story, '8.2 End-to-end and acceptance')
make_table(story,
    ['Specification (e2e/)', 'What it pins'],
    [
        ['smoke.spec.ts', 'The golden path: boot, auth, project creation.'],
        ['isolation.spec.ts', 'Cross-tenant isolation end to end.'],
        ['pipeline.spec.ts', 'Script to rendered cut through the queue.'],
        ['premium-ux.spec.ts', 'The premium surfaces and their affordances.'],
        ['mobile-sweep.spec.ts', 'The view sweep on mobile viewports.'],
        ['whiteboard.spec.ts', 'The whiteboard lane, documents to render.'],
        ['creator-intelligence.spec.ts', 'The 2.0 intelligence surfaces in combination.'],
    ],
    [0.34, 0.66],
    caption='Table 10 - The seven Playwright e2e specifications.')
body(story,
     'On top of the specs sits the S87 acceptance battery - 18 mechanical checks '
     'running real renders through both engine lanes with zero AI spend, wired into '
     'the CI e2e job. Quality enforcement beyond the suites is itself a feature '
     'area: QC enforcement landed in S40, the per-org content policy in S49, and '
     'retention reporting in S72. The nightly battery job exercises the fuller '
     'route battery so drift is caught within a day, not at release time.')

# =================================================================
# 9. CI/CD
# =================================================================
h1(story, '9. CI/CD')
h2(story, '9.1 The pipeline')
make_table(story,
    ['Job (ci.yml)', 'What it does'],
    [
        ['secrets', 'Gitleaks secret scan of every push.'],
        ['check', 'Typecheck, lint, unit suite, billing suite.'],
        ['build', 'The production standalone build.'],
        ['coverage', 'Coverage measurement over the unit suite.'],
        ['postgres', 'Migration integrity against a real Postgres.'],
        ['e2e', 'Playwright suite plus the S87 acceptance battery.'],
    ],
    [0.20, 0.80],
    caption='Table 11 - The six ci.yml jobs; the nightly workflow adds the battery job.')
body(story,
     'All six jobs are green on origin/main at ce7e9c3. The nightly workflow '
     '(nightly.yml) runs the battery job - the extended route battery - on a '
     'schedule so slow regressions surface within a day. The one live caveat: '
     'local HEAD 42238f7 (plus its backup commit) is two commits ahead and '
     'unpushed, because the development sandbox holds no TF_TOKEN; pushing from an '
     'authenticated environment is the first item of the runbook in Chapter 11.')
h2(story, '9.2 The apt mirror outage (a CI lesson in three acts)')
body(story,
     'The e2e job installs ffmpeg through apt, and for several days the runner\'s '
     'azure mirror flapped on DNS. Attempt one appended the canonical archive to '
     'the mirror list - and failed, because apt\'s rotation semantics kept retrying '
     'the dead host and burned six of eight step-minutes on timeouts. Attempt two '
     'swapped the mirror with sed - better, but it depended on the swap landing '
     'before the flap. The standing fix is probe-and-swap: before apt runs, the '
     'workflow health-probes the four indexes apt update actually fetches (noble, '
     'noble-updates, noble-backports, noble-security - the per-index flap is why a '
     'single-index probe is insufficient) and swaps /etc/apt/apt-mirrors.txt '
     'wholesale to the canonical archive on any failure. Healthy days pay about '
     'three seconds of probing; outage days pay at worst a sixty-second probe and '
     'never touch the dead mirror.')
body(story,
     'The same incident exposed a second trap: with the mirror briefly recovered, '
     'the probe passed and the step still hung - systemd-run was waiting '
     'indefinitely on apt-daily.service, whose unattended-upgrades run had been '
     'stuck since boot. The apt lock wait has no timeout of its own, so the '
     'workflow now bounds it (timeout 60 on the apt-daily wait, '
     'DPkg::Lock::Timeout=120 on apt itself) and the step budget went from 8 to 10 '
     'minutes for headroom. The general laws, both now in the workflow comments: '
     'never depend on apt\'s rotation semantics, and every lock wait needs a '
     'timeout you own.')

# =================================================================
# 10. Deployment & Operations
# =================================================================
h1(story, '10. Deployment and Operations')
h2(story, '10.1 The topology of record')
body(story,
     'The S33 deployment decision fixed one topology. Four artifacts had '
     'accumulated - fly.toml, the Dockerfile, docker-compose.yml and vercel.json - '
     'and the decision recorded which is real: Fly.io runs the app, with the web '
     'process group (two machines behind the Fly proxy) and the worker process '
     'group (one machine, scale with fly scale count worker=2) built from one '
     'image. The deciding constraint is the worker: rendering and the durable '
     'queue are long-running processes a serverless platform cannot host, which is '
     'also why Vercel is marked preview-only and carries no data.')
make_table(story,
    ['Layer', 'Choice of record'],
    [
        ['Application', 'Fly.io: web (2 machines) + worker (1, scalable) from one image.'],
        ['Database', 'Neon Postgres (or equivalent managed Postgres); prisma migrate deploy.'],
        ['Object storage', 'Cloudflare R2 (S3-compatible) with presigned-URL delivery; local-disk mode for single-box dev.'],
        ['Previews', 'vercel.json - fluid-compute preview builds only; NOT production.'],
        ['Local development', 'docker-compose.yml: Postgres + web + worker.'],
        ['Voice server (optional)', 'Self-hosted Chatterbox Turbo on a persistent box (Oracle free-tier ARM works); TUBEFORGE_SHARED_VOICE_URL/KEY.'],
    ],
    [0.26, 0.74],
    caption='Table 12 - The deployment topology of record (S33 decision).')
h2(story, '10.2 Provisioning and migration procedure')
body(story,
     'First deploy: create the Neon project and the R2 bucket, then fly launch '
     '--no-deploy --copy-config, set the secrets (at minimum TUBEFORGE_AUTH_SECRET, '
     'TUBEFORGE_ENCRYPTION_KEY, DATABASE_URL and the S3 block), and deploy. '
     'Migrations run explicitly on first deploy - the postinstall script also '
     'baselines an unmanaged database automatically, but the explicit form is the '
     'procedure of record:')
code_block(story, [
    'npx prisma migrate deploy --schema prisma/schema.prisma',
    'fly deploy                                     # web + worker from one image',
    'fly scale count worker=2 --app <app>           # scale the worker tier',
], label='Schema and deploy')
h2(story, '10.3 Backups and the restore drill')
body(story,
     'Two scripts cover backups: scripts/backup.sh for the local dev stack and '
     'scripts/backup-postgres.sh (npm run db:backup:pg) for the production '
     'database, with the restore procedure drilled in docs/runbooks/backup-restore.md. '
     'The S33 session note stands: a backup that has never been restored is a '
     'hypothesis, not a backup - the runbook exists so the drill is a documented, '
     'repeatable path rather than an improvisation during an incident.')
h2(story, '10.4 The outstanding production gate')
body(story,
     'Section 5.3 records it and it belongs in every operations review: the '
     'Chromium-carrying production image has never been built and smoke-tested '
     '(the dev sandbox has no Docker daemon). The Dockerfile lines are in, the '
     'dependency closure is verified statically, and a real docker build plus an '
     'in-container whiteboard render remains a required gate before the container '
     'is called production-ready. It is ROADMAP Critical item 2.')

# =================================================================
# 11. Documentation Audit & Maintenance Runbook
# =================================================================
h1(story, '11. Documentation Audit and Maintenance Runbook')
h2(story, '11.1 What the audit found')
body(story,
     'The audit re-measured every headline figure in the repository documents '
     'against the working tree at 42238f7. Three numbers in ARCHITECTURE.md have '
     'drifted, all with the same root cause: the document was reconciled against '
     'the live source at S75 (2026-11-10), and the S88 through S94 slices landed '
     'after that reconciliation without a fresh pass. The design contracts for '
     'those slices live in docs/design/, which is correct as a practice - but the '
     'headline counts in the architecture document must be re-derived whenever the '
     'reconciliation ages past a landing.')
callout(story, '116 -> 123  |  22 -> 23  |  117 -> 132',
        'Route files, migrations and library modules: documented at the S75 '
        'reconciliation versus measured at 42238f7.')
make_table(story,
    ['Artifact', 'Documented', 'Actual at 42238f7'],
    [
        ['API route files (ARCHITECTURE.md 1.1)', '116', '123 route.ts files'],
        ['Prisma migrations (ARCHITECTURE.md 1.2)', '22', '23 (s94_scene3d added)'],
        ['Library modules (ARCHITECTURE.md 1.1)', '117', '132 under src/lib/tubeforge'],
        ['Prisma models', '32', '32 (in agreement)'],
        ['ROADMAP 2.0 items', '13 planned', '13 / 13 landed at v1'],
        ['Worklog coverage', 'through S75', 'through S94 (THE LAST ROW)'],
    ],
    [0.44, 0.24, 0.32],
    caption='Table 13 - Documentation drift audit, measured 2026-11-12.',
    center_cols=(1, 2))
h2(story, '11.2 The standing reconciliation practice')
body(story,
     'The fix is not a one-off edit; the S75 reconciliation record '
     '(docs/audits/s75-architecture-reconciliation-record.md) defines the practice '
     'and it should be re-run after every engine-level landing: re-derive the '
     'counts from the four sources of truth (prisma/schema.prisma, '
     'prisma/migrations/, src/app/api/ and src/lib/tubeforge/), update the '
     'headline numbers in ARCHITECTURE.md, and record the reconciliation in '
     'docs/audits/. Two companion laws from the worklog: when a job kind is added, '
     'every kind ledger moves in the same slice (the S88 lesson, applied '
     'correctly in S94); and the worklog is the session log - 67 session headers '
     'from S0 to S94, with S94 marking the last ROADMAP row.')
h2(story, '11.3 The maintenance runbook')
make_table(story,
    ['Command', 'Purpose'],
    [
        ['npm run check', 'Typecheck + lint + unit suite + billing suite. Run before every push.'],
        ['npm test', 'The unit suite alone (471 tests at 42238f7).'],
        ['npm run test:e2e', 'The seven Playwright specifications.'],
        ['npm run worker', 'Run the durable-queue worker locally.'],
        ['npm run db:migrate', 'Create a migration from schema changes.'],
        ['npm run db:sync-sqlite', 'Regenerate the SQLite dev mirror from the source schema.'],
        ['npm run db:backup:pg', 'Backup the production Postgres (see the restore runbook).'],
        ['npm run auth:reset', 'Local credential reset helper.'],
        ['node scripts/measure-boot.js', 'The boot-payload diagnostic added with 42238f7.'],
        ['git push origin main', 'Push the two unpushed commits (needs TF_TOKEN; first runbook item).'],
    ],
    [0.32, 0.68],
    caption='Table 14 - The maintenance command set.', font_size=8.8)
h2(story, '11.4 The standing risk register')
make_table(story,
    ['Risk', 'State and discipline'],
    [
        ['Docker image smoke (Critical 2)', 'PENDING - needs a Docker-capable runner; the gate before calling the container production-ready.'],
        ['S74 real motion measurement (Critical 1)', 'OPEN - the auto-resume loop (cron 521163) drives 8 paired renders + 16 blind scores.'],
        ['Timeline soak gate', '14+ days with zero v1-document renders before the legacy fallback retires.'],
        ['Z.ai gateway outages', 'One-probe resumption discipline; LLM whiteboard planner stays gated on it.'],
        ['Production TUBEFORGE_ENCRYPTION_KEY on Vercel', 'Owner-side, unverified; Vercel carries no production data but the key audit is open.'],
        ['Open dependency PRs', 'Majors tested individually, never batch-merged.'],
        ['Unpushed local commits', '42238f7 + backup commit await a TF_TOKEN-capable push.'],
    ],
    [0.36, 0.64],
    caption='Table 15 - Standing risks tracked in the worklog and ROADMAP.', font_size=8.8)

# =================================================================
# Appendix A
# =================================================================
h1(story, 'Appendix A. Quick Reference')
h2(story, 'A.1 Environment variables')
make_table(story,
    ['Variable', 'Purpose'],
    [
        ['TUBEFORGE_AUTH_SECRET', 'Session signing. The production fail-safe refuses to serve without it.'],
        ['TUBEFORGE_ENCRYPTION_KEY', 'AES-256-GCM key material for provider credentials and YouTube tokens (v1. format).'],
        ['DATABASE_URL', 'PostgreSQL connection string (Neon in production).'],
        ['TUBEFORGE_STORAGE_DRIVER', 'local or s3 - S3/R2 mode is the default for any real deployment.'],
        ['TUBEFORGE_S3_* (endpoint, bucket, keys)', 'The S3-compatible block; presigned-URL delivery is built and tested.'],
        ['TUBEFORGE_SHARED_VOICE_URL / _KEY', 'The optional self-hosted voice server (Chatterbox Turbo).'],
        ['TUBEFORGE_SPAWN_VOICE_SERVER', 'Supervisor-spawned voice server - single-box dev only.'],
        ['WB_CHROMIUM_LAUNCH_ARGS', 'Chromium launch discipline: --no-sandbox --disable-dev-shm-usage.'],
        ['PLAYWRIGHT_BROWSERS_PATH', '/opt/ms-playwright in the production image.'],
    ],
    [0.38, 0.62],
    caption='Table 16 - The environment variables a maintainer touches.', font_size=8.8)
h2(story, 'A.2 Document index')
make_table(story,
    ['Path', 'What lives there'],
    [
        ['ARCHITECTURE.md', 'Current (S75-reconciled) and target architecture. Headline counts re-derive on every landing (Ch. 11).'],
        ['ROADMAP.md', 'Stages 1-7 plus the 2.0 track table - 13 items, all at v1, with tails recorded.'],
        ['worklog.md', 'The session log: 67 headers, S0 to S94. The narrative source of record.'],
        ['DEPLOYMENT.md', 'The topology of record, provisioning checklist, Chromium worker contract.'],
        ['SECURITY.md / SETUP.md / RISK_REGISTER.md', 'Security and release notes; the local setup guide; the standing risk register.'],
        ['docs/design/s84-s94', 'Design contracts for the 2.0 systems (critic, timeline, reference, stock, provider, board, pacing, rig, 3D).'],
        ['docs/audits/', '29 audit and acceptance records, including the S75 architecture reconciliation.'],
        ['docs/baselines/', 'Lint, coverage and benchmark baselines per session.'],
        ['docs/runbooks/', 'backup-restore.md and the S55 human evaluation kit.'],
    ],
    [0.32, 0.68],
    caption='Table 17 - Where the knowledge lives.', font_size=8.8)
body(story,
     'This handbook was generated from the live repository at revision 42238f7 on '
     '12 November 2026. Figures were measured, not quoted: route, module and '
     'migration counts come from the working tree; test counts from the suite '
     'run; the boot payload from scripts/measure-boot.js receipts; and the '
     'session-by-session growth from the worklog records. When the repository '
     'moves, re-measure - Chapter 11 exists because documents that quote numbers '
     'age faster than the systems they describe.')

# ------------------------------------------------------------------
doc.multiBuild(story, onFirstPage=on_page, onLaterPages=on_page)
print('body built:', OUT_BODY)

from pypdf import PdfReader
r = PdfReader(OUT_BODY)
print('body pages:', len(r.pages))
