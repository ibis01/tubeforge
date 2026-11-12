#!/usr/bin/env python3
"""Merge cover (Playwright) + body (ReportLab) into the final handbook PDF."""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

BUILD = '/home/z/my-project/scripts/handbook-build'
COVER = f'{BUILD}/cover.pdf'
BODY = f'{BUILD}/body.pdf'
OUT = '/home/z/my-project/download/TubeForge_Maintenance_Handbook.pdf'


def normalize_page_to_a4(page):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 0.05 or abs(h - A4_H) > 0.05:
        page.scale_to(A4_W, A4_H)
    return page


writer = PdfWriter()
writer.add_page(normalize_page_to_a4(PdfReader(COVER).pages[0]))
for page in PdfReader(BODY).pages:
    writer.add_page(normalize_page_to_a4(page))
writer.add_metadata({
    '/Title': 'TubeForge Maintenance Handbook',
    '/Author': 'Z.ai',
    '/Creator': 'Z.ai',
    '/Subject': 'Maintenance handbook for the TubeForge multi-tenant AI video platform',
})
with open(OUT, 'wb') as f:
    writer.write(f)

r = PdfReader(OUT)
print('final pages:', len(r.pages))
for i in (0, 1, len(r.pages) - 1):
    p = r.pages[i]
    print(f'  page {i+1}: {float(p.mediabox.width):.1f} x {float(p.mediabox.height):.1f} pt')
