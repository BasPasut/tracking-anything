#!/usr/bin/env python3
"""Write a synthetic 5 s, 60 fps rally (4 shots, a moving "player" block) as raw RGB to stdout.

Usage: python3 scripts/make-synthetic-rally.py | ffmpeg -f rawvideo -pix_fmt rgb24 -s 1280x720 -r 60 -i - -c:v libx264 -pix_fmt yuv420p rally.mp4
"""
import sys, math
W,H,FPS,N=1280,720,60,300
bg=bytearray([30,110,60]*W*H)
def rect(buf,x0,y0,x1,y1,c):
    for y in range(max(0,y0),min(H,y1)):
        row=y*W*3
        for x in range(max(0,x0),min(W,x1)):
            i=row+x*3; buf[i:i+3]=c
# court lines
for y in (150,600):
    rect(bg,200,y,1080,y+4,bytes([230,230,230]))
for x in (200,1076):
    rect(bg,x,150,x+4,604,bytes([230,230,230]))
bg=bytes(bg)
# shuttle path: shots alternating between near (y=560) and far (y=200), parabola arc upward
hits=[(300,560),(900,200),(400,560),(1000,220),(500,560)]
shot_len=60
out=sys.stdout.buffer
for f in range(N):
    buf=bytearray(bg)
    # slow-moving player block
    px=int(600+150*math.sin(f/40)); rect(buf,px,520,px+60,640,bytes([200,60,60]))
    k=f//shot_len; s=(f%shot_len)/shot_len
    if 20<=f<20+shot_len*4:
        g=f-20; k=g//shot_len; s=(g%shot_len)/shot_len
        (x0,y0),(x1,y1)=hits[k],hits[k+1]
        x=x0+(x1-x0)*s; y=y0+(y1-y0)*s-220*4*s*(1-s)
        cx,cy=int(x),int(y)
        rect(buf,cx-3,cy-3,cx+3,cy+3,bytes([255,255,255]))
    out.write(buf)
