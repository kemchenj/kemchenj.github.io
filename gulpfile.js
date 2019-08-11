var gulp = require('gulp');

gulp.task('minify-js', function (cb) {
  var uglify = require('uglify-es');
  var composer = require('gulp-uglify/composer');
  var pump = require('pump');
  var minify = composer(uglify, console);
  pump([
    gulp.src('./public/**/*.js'),
    minify({}),
    gulp.dest('./public')
  ],
    cb
  );
});

// 压缩 public 目录 css
gulp.task('minify-css', function() {
  var minifycss = require('gulp-clean-css');
  return gulp.src('./public/**/*.css')
    .pipe(minifycss())
    .pipe(gulp.dest('./public'));
});

// 压缩 public 目录 html
gulp.task('minify-html', function() {
  var htmlmin = require('gulp-htmlmin');
  var htmlclean = require('gulp-htmlclean');
  return gulp.src('./public/**/*.html')
    .pipe(htmlclean())
    .pipe(htmlmin({
      removeComments: true,
      minifyJS: true,
      minifyCSS: true,
      minifyURLs: true,
    }))
    .pipe(gulp.dest('./public'))
});

// 执行 gulp 命令时执行的任务
gulp.task('default', gulp.parallel(
  'minify-html','minify-css','minify-js'
));
