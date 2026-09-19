import sharp from 'sharp';

const generatedMark = 'assets/salcara-icon-imagegen.png';
const mark = await sharp(generatedMark).resize(700, 700, { fit: 'contain' }).png().toBuffer();
const foreground = await sharp(generatedMark).resize(640, 640, { fit: 'contain' }).png().toBuffer();
const alpha = await sharp(foreground).extractChannel('alpha').png().toBuffer();
const monochrome = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#FFFFFF' } })
  .joinChannel(alpha)
  .png()
  .toBuffer();
const tile = Buffer.from('<svg width="900" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="900" rx="220" fill="#EFF6FF"/></svg>');

await Promise.all([
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#FFFFFF' } })
    .composite([{ input: tile, left: 62, top: 62 }, { input: mark, left: 162, top: 162 }])
    .png()
    .toFile('assets/icon.png'),
  sharp({ create: { width: 512, height: 512, channels: 4, background: '#FFFFFF' } })
    .composite([{ input: await sharp(generatedMark).resize(360, 360, { fit: 'contain' }).png().toBuffer(), left: 76, top: 76 }])
    .png()
    .toFile('assets/splash-icon.png'),
  sharp({ create: { width: 64, height: 64, channels: 4, background: '#EFF6FF' } })
    .composite([{ input: await sharp(generatedMark).resize(52, 52, { fit: 'contain' }).png().toBuffer(), left: 6, top: 6 }])
    .png()
    .toFile('assets/favicon.png'),
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: foreground, left: 192, top: 192 }])
    .png()
    .toFile('assets/android-icon-foreground.png'),
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#EFF6FF' } }).png().toFile('assets/android-icon-background.png'),
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: monochrome, left: 192, top: 192 }])
    .png()
    .toFile('assets/android-icon-monochrome.png'),
]);
