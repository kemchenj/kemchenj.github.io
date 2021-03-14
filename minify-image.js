const imagemin = require('imagemin');
const imageminWebp = require('imagemin-webp');

(async () => {
  await imagemin(
    [
      './source/images/*.{jpg,png}',
      '!avatar.jpg',
    ],
    {
      destination: './source/images',
      plugins: [imageminWebp({})]
    }
  );

  console.log('Images optimized');
})();
