#!/usr/bin/env python3
"""Charts for the TubeForge Maintenance Handbook (real repo data)."""
import matplotlib
matplotlib.use('Agg')
import matplotlib.font_manager as fm
fm.fontManager.addfont('/usr/share/fonts/truetype/chinese/NotoSansSC-Regular.ttf')
fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['Noto Sans SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# Template 07 Crystal Blue body palette
ACCENT = '#2d7ab3'
HEADER_FILL = '#1a4a7a'
BORDER = '#c0d0e2'
TEXT_PRIMARY = '#142840'
TEXT_MUTED = '#5a7a96'

OUT = '/home/z/my-project/scripts/handbook-build'

# ---------------------------------------------------------------
# Chart 1 - Boot payload before/after commit 42238f7 (gz bytes)
# Measured by scripts/measure-boot.js (dev boot payload diagnostic)
# ---------------------------------------------------------------
fig, ax = plt.subplots(figsize=(7.0, 3.1), dpi=200, constrained_layout=True)
labels = ['Before\n(static imports, 34 assets)', 'After 42238f7\n(dashboard eager + 10 lazy, 20 assets)']
values = [9.84, 5.12]
bars = ax.bar(labels, values, width=0.48, color=[BORDER, ACCENT], edgecolor='none', zorder=3)
for b, v in zip(bars, values):
    ax.text(b.get_x() + b.get_width() / 2, v + 0.22, f'{v:.2f} MB',
            ha='center', va='bottom', fontsize=11, color=TEXT_PRIMARY, fontweight='bold')
ax.text(0.5, values[1] + 1.6, '-48%  (9.84 MB -> 5.12 MB gzipped)',
        ha='center', va='bottom', fontsize=10, color=HEADER_FILL, fontstyle='italic')
ax.set_ylabel('Dev boot payload (MB, gzipped)', fontsize=10, color=TEXT_PRIMARY)
ax.set_ylim(0, 11.8)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.spines['left'].set_color(BORDER)
ax.spines['bottom'].set_color(BORDER)
ax.tick_params(colors=TEXT_MUTED, labelsize=9.5)
ax.grid(axis='y', linestyle='--', alpha=0.2, linewidth=0.5, color=TEXT_MUTED, zorder=0)
fig.savefig(f'{OUT}/chart-boot.png', facecolor='white')
plt.close(fig)

# ---------------------------------------------------------------
# Chart 2 - Unit-test growth across the 2.0 track (worklog receipts)
# S89 444 -> S90 455 -> S91 459 -> S92 464 -> S93 468 -> S94+ 471
# ---------------------------------------------------------------
fig, ax = plt.subplots(figsize=(7.0, 3.0), dpi=200, constrained_layout=True)
sessions = ['S89\nstock', 'S90\nprovider', 'S91\nboard', 'S92\npacing', 'S93\nrig', 'S94 3D\n(now)']
counts = [444, 455, 459, 464, 468, 471]
xs = range(len(sessions))
ax.plot(xs, counts, color=ACCENT, linewidth=2.5, zorder=3,
        marker='o', markersize=5, markerfacecolor=ACCENT, markeredgecolor='white')
ax.fill_between(xs, counts, 438, color=ACCENT, alpha=0.12, zorder=2)
for x, c in zip(xs, counts):
    ax.annotate(str(c), (x, c), textcoords='offset points', xytext=(0, 8),
                ha='center', fontsize=10, color=TEXT_PRIMARY, fontweight='bold')
ax.set_xticks(list(xs))
ax.set_xticklabels(sessions, fontsize=9.5)
ax.set_ylabel('Unit tests passing', fontsize=10, color=TEXT_PRIMARY)
ax.set_ylim(438, 482)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
ax.spines['left'].set_color(BORDER)
ax.spines['bottom'].set_color(BORDER)
ax.tick_params(colors=TEXT_MUTED, labelsize=9.5)
ax.grid(axis='y', linestyle='--', alpha=0.2, linewidth=0.5, color=TEXT_MUTED, zorder=0)
fig.savefig(f'{OUT}/chart-tests.png', facecolor='white')
plt.close(fig)

print('charts written')
