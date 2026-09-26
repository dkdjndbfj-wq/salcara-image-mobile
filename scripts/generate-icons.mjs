// Builds every launcher / splash asset from the brand logo (assets/brand-logo.png,
// a transparent PNG extracted from assets/brand-logo-source.png).
// Run: npm run icons
import sharp from 'sharp';

const LOGO = 'assets/brand-logo.png';
const logo = (size) => sharp(LOGO).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const background = (size) => Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="a" cx="22%" cy="16%" r="80%"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F3F5FF"/></radialGradient>
    <radialGradient id="b" cx="88%" cy="92%" r="60%"><stop offset="0" stop-color="#FCE9F4" stop-opacity="0.9"/><stop offset="1" stop-color="#FCE9F4" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#a)"/><rect width="${size}" height="${size}" fill="url(#b)"/></svg>`);
const transparent = (size) => ({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
const place = async (base, input, size, inner) => sharp(base).composite([{ input, left: Math.round((size - inner) / 2), top: Math.round((size - inner) / 2) }]);

const alpha = await sharp(await logo(600)).extractChannel('alpha').png().toBuffer();
const monochrome = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#FFFFFF' } }).joinChannel(alpha).png().toBuffer();

await Promise.all([
  (await place(background(1024), await logo(720), 1024, 720)).png().toFile('assets/icon.png'),
  sharp(background(1024)).png().toFile('assets/android-icon-background.png'),
  (await place(transparent(1024), await logo(600), 1024, 600)).png().toFile('assets/android-icon-foreground.png'),
  (await place(transparent(1024), monochrome, 1024, 600)).png().toFile('assets/android-icon-monochrome.png'),
  (await place(transparent(512), await logo(300), 512, 300)).png().toFile('assets/splash-icon.png'),
  (await place(background(64), await logo(56), 64, 56)).png().toFile('assets/favicon.png'),
]);
console.log('icons generated');
