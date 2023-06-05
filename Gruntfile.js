module.exports = function(grunt) {

  grunt.initConfig({
    htmlmin: {
      options: {
        collapseBooleanAttributes: true,
        collapseWhitespace: true,
        removeComments: true,
        removeEmptyAttributes: true,
        removeRedundantAttributes: true,
        removeScriptTypeAttributes: true
      },
      files: {
        expand: true,
        cwd: 'public/',
        src: [
          '**/*.html',
          'atom.xml',
          'sitemap.xml',
        ],
        dest: 'public/',
      }
    },
    cssmin: {
      files: {
        expand: true,
        cwd: 'public/',
        src: ['**/*.css'],
        dest: 'public/'
      }
    },
    uglify: {
      files: {
        expand: true,
        cwd: 'public/',
        src: ['**/*.js'],
        dest: 'public/',
      }
    }
  });

  grunt.loadNpmTasks('grunt-contrib-htmlmin');
  grunt.loadNpmTasks('grunt-contrib-cssmin');
  grunt.loadNpmTasks('grunt-contrib-uglify');

  grunt.registerTask('default', ['htmlmin', 'cssmin', 'uglify']);
};
