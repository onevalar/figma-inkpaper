from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'release/assets'
FONT=Path('/System/Library/Fonts/STHeiti Light.ttc')
LATIN=Path('/Users/anvalar/.mirasim/skills/synced/fb7e5755-c4f5-4772-9dc2-871ab21f15d2_657737b8-e232-4baf-b78e-786225116d5a/canvas-design/canvas-fonts/WorkSans-Bold.ttf')
def font(size,latin=False): return ImageFont.truetype(str(LATIN if latin else FONT),size)
INK='#242730'; MUTED='#687080'; PAPER='#f6f7f9'; COLORS=['#00a9db','#e90082','#ffda00','#242730']
def icon(size):
    scale=4; im=Image.new('RGB',(size*scale,size*scale),PAPER); d=ImageDraw.Draw(im); k=size*scale/128
    d.rounded_rectangle((20*k,14*k,108*k,114*k),radius=10*k,fill='white',outline='#c9cdd4',width=max(1,int(k)))
    for n,c in enumerate(COLORS):d.rectangle((32*k,35*k+n*14*k,96*k,45*k+n*14*k),fill=c)
    for x,y,dx,dy in [(14,8,12,0),(8,14,0,12),(114,8,-12,0),(120,14,0,12),(14,120,12,0),(8,114,0,-12),(114,120,-12,0),(120,114,0,-12)]:d.line((x*k,y*k,(x+dx)*k,(y+dy)*k),fill=INK,width=max(1,int(2*k)))
    return im.resize((size,size),Image.Resampling.LANCZOS)
for size in [128,512]:icon(size).save(OUT/f'icon-{size}.png')
im=Image.new('RGB',(1920,1080),PAPER);d=ImageDraw.Draw(im)
d.text((120,95),'FIGMA / PRINT WORKFLOW',font=font(24,True),fill=MUTED)
d.text((120,320),'Inkpaper',font=font(110,True),fill=INK)
d.text((120,462),'纸墨',font=font(70),fill=INK)
d.text((120,598),'Prepare. Check. Export.',font=font(38,True),fill=INK)
d.text((120,660),'Local CMYK processing in Figma',font=font(28),fill=MUTED)
d.text((120,908),'ICC  /  BLEED  /  CROP MARKS  /  IMPOSITION',font=font(22,True),fill=MUTED)
x,y,w,h=1130,158,610,760
d.rounded_rectangle((x+16,y+22,x+w+16,y+h+22),radius=14,fill='#e6e8ed')
d.rounded_rectangle((x,y,x+w,y+h),radius=14,fill='white',outline='#c9cdd4',width=2)
for n,c in enumerate(COLORS):
    d.rectangle((x+80+n*114,y+100,x+178+n*114,y+548),fill=c)
    d.text((x+91+n*114,y+577),'CMYK'[n],font=font(30,True),fill=INK)
for xx,yy,dx,dy in [(x-20,y,0,45),(x,y-20,45,0),(x+w+20,y,0,45),(x+w,y-20,-45,0),(x-20,y+h,0,-45),(x,y+h+20,45,0),(x+w+20,y+h,0,-45),(x+w,y+h+20,-45,0)]:d.line((xx,yy,xx+dx,yy+dy),fill=INK,width=2)
d.text((x+80,y+685),'SCREEN → PAPER',font=font(22,True),fill=MUTED)
im.save(OUT/'cover-1920x1080.png')
for name,source,title,sub,dark in [
 ('01-export','ui-export-light.jpg','Prepare your print export','Bleed, crop marks and output formats',False),
 ('02-dark','ui-export-dark.jpg','A focused workspace','Light and dark themes follow Figma',True),
 ('03-check','ui-check-dark.jpg','Understand the risks','Resolution and ICC warnings stay visible',True)]:
    im=Image.new('RGB',(1920,1080),'#171a1f' if dark else PAPER);d=ImageDraw.Draw(im);fg='#f0f1f4' if dark else INK;muted='#a4a9b3' if dark else MUTED
    d.text((110,105),'INKPAPER / 纸墨',font=font(26),fill=muted)
    words=title.split(' '); line=''; lines=[]
    for word in words:
        candidate=(line+' '+word).strip()
        if d.textbbox((0,0),candidate,font=font(65,True))[2]>800:lines.append(line);line=word
        else:line=candidate
    lines.append(line)
    for n,line in enumerate(lines):d.text((110,352+90*n),line,font=font(65,True),fill=fg)
    d.text((110,575),sub,font=font(27),fill=muted)
    d.text((110,916),'Actual UI · simulated test data',font=font(22),fill=muted)
    ui=Image.open(OUT/source).convert('RGB');ui.thumbnail((600,920),Image.Resampling.LANCZOS)
    im.paste(ui,(1190+(600-ui.width)//2,80))
    im.save(OUT/f'{name}-1920x1080.png')
# Contact sheet is an internal visual review, not a store upload.
files=['cover-1920x1080.png','01-export-1920x1080.png','02-dark-1920x1080.png','03-check-1920x1080.png']
sheet=Image.new('RGB',(1280,720),'white')
for n,f in enumerate(files):
    part=Image.open(OUT/f);part.thumbnail((640,360),Image.Resampling.LANCZOS);sheet.paste(part,((n%2)*640,(n//2)*360))
sheet.save(OUT/'contact-sheet.png')
print('Prepared 128/512 icons, 1920×1080 cover and 3 carousel images.')
