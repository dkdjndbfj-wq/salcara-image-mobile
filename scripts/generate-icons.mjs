import sharp from 'sharp';

await Promise.all([
  sharp('assets/salcara-icon.svg').png().toFile('assets/icon.png'),
  sharp('assets/salcara-icon.svg').resize(512, 512).png().toFile('assets/splash-icon.png'),
  sharp('assets/salcara-icon.svg').resize(64, 64).png().toFile('assets/favicon.png'),
  sharp('assets/salcara-foreground.svg').png().toFile('assets/android-icon-foreground.png'),
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#EFF6FF' } }).png().toFile('assets/android-icon-background.png'),
  sharp('assets/salcara-monochrome.svg').png().toFile('assets/android-icon-monochrome.png'),
]);
