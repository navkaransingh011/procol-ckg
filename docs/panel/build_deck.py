#!/usr/bin/env python
"""Build the panel deck for the Procol Code Knowledge Graph from deck_content.json.

Visual system: 16:9, light ground, one indigo accent, amber for gaps, teal for live data, grey for "not built".
Every slide is drawn from shapes (no template dependency) so it renders the same in PowerPoint, Keynote and Google Slides.
"""
import json, sys, math, os
FLAGS = set(os.environ.get("DECK_FLAGS", "").split(","))
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn
from lxml import etree

CONTENT = json.load(open(sys.argv[1]))
OUT = sys.argv[2]

W, H = Emu(12192000), Emu(6858000)   # exact 16:9 (13.333 in x 7.5 in); Keynote checks size against the declared type
BG = RGBColor(0xF7, 0xF7, 0xF9); SURFACE = RGBColor(0xFF, 0xFF, 0xFF)
INK = RGBColor(0x16, 0x16, 0x1A); INK2 = RGBColor(0x5C, 0x5D, 0x66); INK3 = RGBColor(0x9A, 0x9B, 0xA3); LINE = RGBColor(0xE3, 0xE3, 0xE8)
ACCENT = RGBColor(0x5B, 0x5B, 0xD6); ACCENT_SOFT = RGBColor(0xEE, 0xEE, 0xFC)
AMBER = RGBColor(0xB4, 0x53, 0x09); AMBER_SOFT = RGBColor(0xFD, 0xF3, 0xE3)
TEAL = RGBColor(0x0F, 0x76, 0x6E); TEAL_SOFT = RGBColor(0xE6, 0xF4, 0xF2)
RED = RGBColor(0xB3, 0x26, 0x1E); RED_SOFT = RGBColor(0xFD, 0xEC, 0xEA)
GREEN = RGBColor(0x1F, 0x7A, 0x4D); GREEN_SOFT = RGBColor(0xE6, 0xF4, 0xEC)
GREY_SOFT = RGBColor(0xEC, 0xEC, 0xEF)
SANS = "Helvetica Neue"; SERIF = "Georgia"

prs = Presentation(); prs.slide_width = W; prs.slide_height = H
prs.slide_master.element  # touch
_sldSz = prs.part._element.find(qn("p:sldSz")); _sldSz.set("type", "screen16x9")
BLANK = prs.slide_layouts[6]
STATUS = {"exists": (GREEN, GREEN_SOFT, "Exists"), "partial": (AMBER, AMBER_SOFT, "Partial"), "missing": (RED, RED_SOFT, "Not built"), "live": (TEAL, TEAL_SOFT, "Live")}

# ---------- primitives ----------
E = lambda v: Emu(int(round(v)))   # Keynote rejects fractional EMUs; PowerPoint and QuickLook tolerate them

def rect(slide, x, y, w, h, fill=SURFACE, line=None, radius=None, shape=MSO_SHAPE.RECTANGLE):
    x, y, w, h = E(x), E(y), E(w), E(h)
    s = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if radius else shape, x, y, w, h)
    s.fill.solid(); s.fill.fore_color.rgb = fill
    if line is None: s.line.fill.background()
    else: s.line.color.rgb = line; s.line.width = Pt(0.75)
    if "no_effects" not in FLAGS: s.shadow.inherit = False
    if radius and "no_effects" not in FLAGS:
        try: s.adjustments[0] = min(0.5, radius / min(w, h))
        except Exception: pass
    return s

def text(slide, x, y, w, h, s, size=14, color=INK, bold=False, font=SANS, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, italic=False, spacing=None, wrap=True):
    tb = slide.shapes.add_textbox(E(x), E(y), E(w), E(h)); tf = tb.text_frame; tf.word_wrap = wrap
    tf.margin_left = tf.margin_right = Inches(0.05); tf.margin_top = tf.margin_bottom = Inches(0.03); tf.vertical_anchor = anchor
    lines = s if isinstance(s, list) else [s]
    for i, ln in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph(); p.alignment = align
        if spacing: p.space_after = Pt(spacing)
        r = p.add_run(); r.text = ln; f = r.font; f.size = Pt(size); f.color.rgb = color; f.bold = bold; f.italic = italic; f.name = font
    return tb

def bullets(slide, x, y, w, h, items, size=13, color=INK, gap=6, marker="•", marker_color=None, bold_lead=True):
    """items: strings, or (lead, rest) tuples where lead is bold. A string starting with '  ' is a sub-bullet."""
    tb = slide.shapes.add_textbox(E(x), E(y), E(w), E(h)); tf = tb.text_frame; tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(0.05); tf.margin_top = tf.margin_bottom = Inches(0.03)
    first = True
    for it in items:
        sub = isinstance(it, str) and it.startswith("  ")
        p = tf.paragraphs[0] if first else tf.add_paragraph(); first = False
        p.space_after = Pt(gap); p.level = 1 if sub else 0
        m = p.add_run(); m.text = ("– " if sub else f"{marker} "); m.font.size = Pt(size - (1 if sub else 0)); m.font.color.rgb = marker_color or ACCENT; m.font.name = SANS; m.font.bold = True
        if isinstance(it, (list, tuple)):
            r = p.add_run(); r.text = it[0] + " "; r.font.bold = bold_lead; r.font.size = Pt(size); r.font.color.rgb = color; r.font.name = SANS
            r2 = p.add_run(); r2.text = it[1]; r2.font.size = Pt(size); r2.font.color.rgb = color; r2.font.name = SANS
        else:
            r = p.add_run(); r.text = it.strip(); r.font.size = Pt(size - (1 if sub else 0)); r.font.color.rgb = INK2 if sub else color; r.font.name = SANS
    return tb

def pill(slide, x, y, label, fg, bg, size=10, w=None):
    w = w or Inches(0.16 + 0.085 * len(label))
    s = rect(slide, x, y, w, Inches(0.28), fill=bg, radius=Inches(0.14))
    tf = s.text_frame; tf.margin_left = tf.margin_right = Inches(0.06); tf.margin_top = tf.margin_bottom = Inches(0.0); tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER; r = p.add_run(); r.text = label; r.font.size = Pt(size); r.font.bold = True; r.font.color.rgb = fg; r.font.name = SANS
    return s

def arrow(slide, x1, y1, x2, y2, color=INK3, width=1.5):
    if "no_arrows" in FLAGS: return None
    if "plain_arrows" in FLAGS:
        ln = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, E(min(x1, x2)), E(y1 - Inches(0.01)), E(abs(x2 - x1)), E(Inches(0.02))); ln.fill.solid(); ln.fill.fore_color.rgb = color; ln.line.fill.background(); return ln
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, E(x1), E(y1), E(x2), E(y2))
    c.line.color.rgb = color; c.line.width = Pt(width)
    ln = c.line._get_or_add_ln()
    tail = etree.SubElement(ln, qn("a:tailEnd")); tail.set("type", "triangle"); tail.set("w", "med"); tail.set("len", "med")
    return c

def chrome(slide, eyebrow, title, n):
    """Header + footer shared by content slides."""
    bg = rect(slide, 0, 0, W, H, fill=BG)
    if eyebrow: text(slide, Inches(0.6), Inches(0.38), Inches(8), Inches(0.3), eyebrow.upper(), size=10, color=ACCENT, bold=True)
    text(slide, Inches(0.6), Inches(0.62), Inches(11.5), Inches(0.8), title, size=28, color=INK, bold=True)
    rect(slide, Inches(0.6), Inches(1.42), Inches(0.9), Inches(0.05), fill=ACCENT)
    text(slide, Inches(0.6), Inches(7.05), Inches(6), Inches(0.3), "Procol · Code Knowledge Graph & Agent", size=9, color=INK3)
    text(slide, Inches(12.1), Inches(7.05), Inches(0.7), Inches(0.3), str(n), size=9, color=INK3, align=PP_ALIGN.RIGHT)

def status_dot(slide, x, y, kind):
    fg, _, _ = STATUS[kind]
    d = slide.shapes.add_shape(MSO_SHAPE.OVAL, E(x), E(y), Inches(0.13), Inches(0.13)); d.fill.solid(); d.fill.fore_color.rgb = fg; d.line.fill.background()

def legend(slide, x, y, kinds=("exists", "partial", "missing")):
    cx = x
    for k in kinds:
        fg, bg, label = STATUS[k]; status_dot(slide, cx, y + Inches(0.07), k); text(slide, cx + Inches(0.18), y, Inches(1.2), Inches(0.28), label, size=10, color=INK2); cx += Inches(1.15)

def status_list(slide, x, y, w, items, size=12.5, gap=Inches(0.36)):
    """items: {status, text}. Coloured dot + text, one row each, wrapping."""
    cy = y
    for it in items:
        status_dot(slide, x, cy + Inches(0.09), it["status"])
        lines = max(1, math.ceil(len(it["text"]) / (w / Inches(1) * 9.2)))
        text(slide, x + Inches(0.25), cy, w - Inches(0.25), Inches(0.3) * lines, it["text"], size=size, color=INK)
        cy += gap + Inches(0.22) * (lines - 1)
    return cy

def card(slide, x, y, w, h, title, body, kind=None, title_size=13, body_size=11.5):
    fg, bg = (STATUS[kind][0], STATUS[kind][1]) if kind else (ACCENT, SURFACE)
    c = rect(slide, x, y, w, h, fill=SURFACE, line=LINE, radius=Inches(0.12))
    rect(slide, x + Inches(0.03), y + Inches(0.14), Inches(0.05), h - Inches(0.28), fill=fg, radius=Inches(0.025))
    text(slide, x + Inches(0.2), y + Inches(0.12), w - Inches(0.3), Inches(0.35), title, size=title_size, color=INK, bold=True)
    if isinstance(body, list): bullets(slide, x + Inches(0.15), y + Inches(0.5), w - Inches(0.3), h - Inches(0.6), body, size=body_size, gap=3)
    else: text(slide, x + Inches(0.2), y + Inches(0.5), w - Inches(0.35), h - Inches(0.6), body, size=body_size, color=INK2)
    return c

def table(slide, x, y, w, rows, col_widths, header=True, size=11, row_h=Inches(0.36)):
    shape = slide.shapes.add_table(len(rows), len(rows[0]), E(x), E(y), E(w), E(row_h * len(rows))); t = shape.table
    for i, cw in enumerate(col_widths): t.columns[i].width = E(cw)
    for r, row in enumerate(rows):
        t.rows[r].height = E(row_h)
        for c, val in enumerate(row):
            cell = t.cell(r, c); cell.margin_left = cell.margin_right = Inches(0.08); cell.margin_top = cell.margin_bottom = Inches(0.04)
            cell.fill.solid(); cell.fill.fore_color.rgb = ACCENT_SOFT if (header and r == 0) else (SURFACE if r % 2 else BG)
            tf = cell.text_frame; tf.word_wrap = True; p = tf.paragraphs[0]; p.text = ""; run = p.add_run(); run.text = str(val)
            run.font.size = Pt(size); run.font.name = SANS; run.font.bold = header and r == 0; run.font.color.rgb = INK if not (header and r == 0) else ACCENT
    return shape

# ---------- slide builders ----------
def s_title(d, n):
    sl = prs.slides.add_slide(BLANK); rect(sl, 0, 0, W, H, fill=INK)
    rect(sl, Inches(0.8), Inches(2.35), Inches(0.9), Inches(0.06), fill=ACCENT)
    text(sl, Inches(0.8), Inches(1.7), Inches(10), Inches(0.4), d["eyebrow"].upper(), size=12, color=RGBColor(0x8B, 0x8B, 0xF0), bold=True)
    text(sl, Inches(0.8), Inches(2.6), Inches(11.5), Inches(1.6), d["title"], size=48, color=RGBColor(0xF5, 0xF5, 0xF8), bold=False, font=SERIF)
    text(sl, Inches(0.8), Inches(4.35), Inches(10.5), Inches(1.0), d["subtitle"], size=18, color=RGBColor(0xA3, 0xA4, 0xAD))
    text(sl, Inches(0.8), Inches(6.3), Inches(11), Inches(0.5), d["footer"], size=12, color=RGBColor(0x6D, 0x6E, 0x78))

def s_section(d, n):
    sl = prs.slides.add_slide(BLANK); rect(sl, 0, 0, W, H, fill=ACCENT_SOFT)
    text(sl, Inches(0.8), Inches(2.5), Inches(11), Inches(0.4), d.get("eyebrow", "").upper(), size=12, color=ACCENT, bold=True)
    text(sl, Inches(0.8), Inches(2.9), Inches(11.5), Inches(1.4), d["title"], size=40, color=INK, font=SERIF)
    if d.get("subtitle"): text(sl, Inches(0.8), Inches(4.3), Inches(10.5), Inches(1.2), d["subtitle"], size=16, color=INK2)
    text(sl, Inches(12.1), Inches(7.05), Inches(0.7), Inches(0.3), str(n), size=9, color=INK3, align=PP_ALIGN.RIGHT)

def s_bullets(d, n):
    sl = prs.slides.add_slide(BLANK); chrome(sl, d.get("eyebrow"), d["title"], n)
    cols = d.get("columns") or [{"items": d["items"]}]
    cw = (W - Inches(1.2) - Inches(0.4) * (len(cols) - 1)) / len(cols)
    for i, col in enumerate(cols):
        x = Inches(0.6) + (cw + Inches(0.4)) * i
        if col.get("heading"): text(sl, x, Inches(1.7), cw, Inches(0.35), col["heading"], size=14, color=ACCENT, bold=True)
        bullets(sl, x, Inches(1.7) + (Inches(0.42) if col.get("heading") else 0), cw, Inches(4.9), [tuple(it) if isinstance(it, list) else it for it in col["items"]], size=d.get("size", 14), gap=d.get("gap", 8))
    if d.get("note"): text(sl, Inches(0.6), Inches(6.5), Inches(12), Inches(0.5), d["note"], size=11, color=INK3, italic=True)

def s_status(d, n):
    sl = prs.slides.add_slide(BLANK); chrome(sl, d.get("eyebrow"), d["title"], n); legend(sl, Inches(9.2), Inches(0.45), d.get("legend", ("exists", "partial", "missing")))
    cols = d["columns"]; cw = (W - Inches(1.2) - Inches(0.4) * (len(cols) - 1)) / len(cols)
    for i, col in enumerate(cols):
        x = Inches(0.6) + (cw + Inches(0.4)) * i
        if col.get("heading"): text(sl, x, Inches(1.7), cw, Inches(0.35), col["heading"], size=14, color=ACCENT, bold=True)
        status_list(sl, x, Inches(1.7) + (Inches(0.42) if col.get("heading") else 0), cw, col["items"], size=d.get("size", 12.5), gap=Inches(d.get("gap", 0.36)))
    if d.get("note"): text(sl, Inches(0.6), Inches(6.55), Inches(12), Inches(0.45), d["note"], size=11, color=INK3, italic=True)

def s_numbers(d, n):
    sl = prs.slides.add_slide(BLANK); chrome(sl, d.get("eyebrow"), d["title"], n)
    tiles = d["tiles"]; per_row = 3 if len(tiles) > 4 else len(tiles); rows = math.ceil(len(tiles) / per_row)
    tw = (W - Inches(1.2) - Inches(0.3) * (per_row - 1)) / per_row; th = Inches(1.55) if rows > 1 else Inches(2.2)
    for i, t in enumerate(tiles):
        r, c = divmod(i, per_row); x = Inches(0.6) + (tw + Inches(0.3)) * c; y = Inches(1.75) + (th + Inches(0.25)) * r
        rect(sl, x, y, tw, th, fill=SURFACE, line=LINE, radius=Inches(0.12))
        text(sl, x + Inches(0.2), y + Inches(0.15), tw - Inches(0.4), Inches(0.7), t["value"], size=30, color=ACCENT, bold=True)
        text(sl, x + Inches(0.2), y + Inches(0.82), tw - Inches(0.4), Inches(0.65), t["label"], size=12.5, color=INK, bold=True)
        if t.get("sub"): text(sl, x + Inches(0.2), y + th - Inches(0.42), tw - Inches(0.4), Inches(0.36), t["sub"], size=10, color=INK3)
    if d.get("note"): text(sl, Inches(0.6), Inches(6.55), Inches(12), Inches(0.45), d["note"], size=11, color=INK3, italic=True)

def s_cards(d, n):
    sl = prs.slides.add_slide(BLANK); chrome(sl, d.get("eyebrow"), d["title"], n)
    cards = d["cards"]; per_row = d.get("per_row", 3 if len(cards) > 4 else len(cards)); rows = math.ceil(len(cards) / per_row)
    cw = (W - Inches(1.2) - Inches(0.3) * (per_row - 1)) / per_row; ch = (Inches(4.9) - Inches(0.25) * (rows - 1)) / rows
    for i, c in enumerate(cards):
        r, col = divmod(i, per_row); x = Inches(0.6) + (cw + Inches(0.3)) * col; y = Inches(1.75) + (ch + Inches(0.25)) * r
        card(sl, x, y, cw, ch, c["title"], c["body"], kind=c.get("status"), body_size=c.get("size", 11.5))
    if d.get("note"): text(sl, Inches(0.6), Inches(6.7), Inches(12), Inches(0.4), d["note"], size=11, color=INK3, italic=True)

def s_table(d, n):
    sl = prs.slides.add_slide(BLANK); chrome(sl, d.get("eyebrow"), d["title"], n)
    if "no_tables" in FLAGS: return
    widths = [Inches(w) for w in d["col_widths"]]
    table(sl, Inches(0.6), Inches(1.75), sum(widths, Emu(0)), d["rows"], widths, size=d.get("size", 11), row_h=Inches(d.get("row_h", 0.36)))
    if d.get("note"): text(sl, Inches(0.6), Inches(6.55), Inches(12), Inches(0.45), d["note"], size=11, color=INK3, italic=True)

def s_architecture(d, n):
    """Sources -> pipeline -> graph -> agent -> people. Boxes and arrows drawn from shapes."""
    sl = prs.slides.add_slide(BLANK); chrome(sl, d.get("eyebrow"), d["title"], n)
    y0 = Inches(1.95); bh = Inches(0.62)
    def box(x, y, w, label, sub=None, fill=SURFACE, fg=INK, line=LINE):
        b = rect(sl, x, y, w, bh if not sub else Inches(0.86), fill=fill, line=line, radius=Inches(0.1))
        text(sl, x, y + Inches(0.08), w, Inches(0.35), label, size=12, color=fg, bold=True, align=PP_ALIGN.CENTER)
        if sub: text(sl, x, y + Inches(0.42), w, Inches(0.4), sub, size=9.5, color=RGBColor(0xE4, 0xE4, 0xFB) if fill == ACCENT else INK3, align=PP_ALIGN.CENTER)
        return b
    # column 1: sources
    x1 = Inches(0.6); cw1 = Inches(2.35)
    text(sl, x1, Inches(1.62), cw1, Inches(0.3), "SOURCES", size=9.5, color=INK3, bold=True)
    srcs = d["sources"]
    for i, s in enumerate(srcs): box(x1, y0 + Inches(0.98) * i, cw1, s["label"], s.get("sub"), fill=TEAL_SOFT if s.get("live") else SURFACE, fg=TEAL if s.get("live") else INK)
    # column 2: pipeline
    x2 = Inches(3.45); cw2 = Inches(2.5)
    text(sl, x2, Inches(1.62), cw2, Inches(0.3), "PIPELINE", size=9.5, color=INK3, bold=True)
    for i, s in enumerate(d["pipeline"]): box(x2, y0 + Inches(0.98) * i, cw2, s["label"], s.get("sub"))
    # column 3: the graph
    x3 = Inches(6.45); cw3 = Inches(2.5)
    text(sl, x3, Inches(1.62), cw3, Inches(0.3), "ONE POSTGRES", size=9.5, color=INK3, bold=True)
    g = rect(sl, x3, y0, cw3, Inches(0.98) * len(d["pipeline"]) - Inches(0.12), fill=ACCENT_SOFT, line=None, radius=Inches(0.14))
    text(sl, x3, y0 + Inches(0.12), cw3, Inches(0.4), d["graph"]["label"], size=13, color=ACCENT, bold=True, align=PP_ALIGN.CENTER)
    bullets(sl, x3 + Inches(0.12), y0 + Inches(0.55), cw3 - Inches(0.2), Inches(3.2), d["graph"]["items"], size=10.5, gap=3, marker_color=ACCENT, color=INK)
    # column 4: agent + UI
    x4 = Inches(9.45); cw4 = Inches(3.3)
    text(sl, x4, Inches(1.62), cw4, Inches(0.3), "AGENT & PEOPLE", size=9.5, color=INK3, bold=True)
    for i, s in enumerate(d["agent"]): box(x4, y0 + Inches(0.98) * i, cw4, s["label"], s.get("sub"), fill=SURFACE if not s.get("accent") else ACCENT, fg=INK if not s.get("accent") else SURFACE, line=LINE if not s.get("accent") else None)
    # arrows between columns (mid height)
    mid = y0 + Inches(0.98) * len(d["pipeline"]) / 2 - Inches(0.2)
    arrow(sl, x1 + cw1, mid, x2, mid); arrow(sl, x2 + cw2, mid, x3, mid); arrow(sl, x3 + cw3, mid, x4, mid)
    if d.get("note"): text(sl, Inches(0.6), Inches(6.55), Inches(12), Inches(0.45), d["note"], size=11, color=INK3, italic=True)

def s_flow(d, n):
    """A left-to-right chain of steps with a caption under each: how an answer is produced."""
    sl = prs.slides.add_slide(BLANK); chrome(sl, d.get("eyebrow"), d["title"], n)
    steps = d["steps"]; k = len(steps); gap = Inches(0.35); bw = (W - Inches(1.2) - gap * (k - 1)) / k; y = Inches(2.0); bh = Inches(0.9)
    for i, s in enumerate(steps):
        x = Inches(0.6) + (bw + gap) * i
        b = rect(sl, x, y, bw, bh, fill=ACCENT if s.get("accent") else SURFACE, line=None if s.get("accent") else LINE, radius=Inches(0.12))
        text(sl, x, y + Inches(0.12), bw, Inches(0.35), s["label"], size=12.5, color=SURFACE if s.get("accent") else INK, bold=True, align=PP_ALIGN.CENTER)
        if s.get("time"): text(sl, x, y + Inches(0.5), bw, Inches(0.3), s["time"], size=10, color=RGBColor(0xD8, 0xD8, 0xF8) if s.get("accent") else INK3, align=PP_ALIGN.CENTER)
        text(sl, x - Inches(0.05), y + bh + Inches(0.15), bw + Inches(0.1), Inches(1.6), s["caption"], size=10.5, color=INK2)
        if i < k - 1: arrow(sl, x + bw, y + bh / 2, x + bw + gap, y + bh / 2)
    if d.get("below"):
        text(sl, Inches(0.6), Inches(4.75), Inches(12), Inches(0.35), d["below"]["heading"], size=13, color=ACCENT, bold=True)
        bullets(sl, Inches(0.6), Inches(5.12), Inches(12), Inches(1.6), [tuple(it) if isinstance(it, list) else it for it in d["below"]["items"]], size=12, gap=4)

def s_quote(d, n):
    sl = prs.slides.add_slide(BLANK); rect(sl, 0, 0, W, H, fill=INK)
    text(sl, Inches(1.0), Inches(2.2), Inches(11.3), Inches(2.4), d["quote"], size=30, color=RGBColor(0xF5, 0xF5, 0xF8), font=SERIF)
    text(sl, Inches(1.0), Inches(4.9), Inches(11), Inches(0.6), d.get("attribution", ""), size=13, color=RGBColor(0xA3, 0xA4, 0xAD))
    text(sl, Inches(12.1), Inches(7.05), Inches(0.7), Inches(0.3), str(n), size=9, color=RGBColor(0x6D, 0x6E, 0x78), align=PP_ALIGN.RIGHT)

BUILDERS = {"title": s_title, "section": s_section, "bullets": s_bullets, "status": s_status, "numbers": s_numbers, "cards": s_cards, "table": s_table, "architecture": s_architecture, "flow": s_flow, "quote": s_quote}

for i, d in enumerate(CONTENT["slides"], 1):
    BUILDERS[d["type"]](d, i)
    # Speaker notes are NOT embedded: Keynote 15 rejects python-pptx notes pages ("file format is invalid").
    # They are written to SPEAKER_NOTES.md beside the deck instead.
    pass

notes = [(i, d.get("title") or d.get("quote", "")[:60], d["notes"]) for i, d in enumerate(CONTENT["slides"], 1) if d.get("notes")]
if notes:
    with open(OUT.rsplit(".", 1)[0] + "_SPEAKER_NOTES.md", "w") as f:
        f.write("# Speaker notes\n\n" + "\n\n".join(f"## Slide {i}: {t}\n\n{n}" for i, t, n in notes) + "\n")
prs.save(OUT)
print(f"wrote {OUT} with {len(prs.slides)} slides")
