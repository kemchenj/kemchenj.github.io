const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '../scripts/fontawesome-subsetting.js'), 'utf8');

function loadPlugin(command = 'generate') {
    const filters = new Map();
    let generatedSubsets;
    const mocks = {
        jsdom: { JSDOM },
        'fontawesome-subset': {
            fontawesomeSubset(input) {
                generatedSubsets = JSON.parse(JSON.stringify(input));
            }
        },
        fs: { writeFileSync() {} },
        purgecss: { PurgeCSS: class {
            async purge() { return [{ css: '' }]; }
        } }
    };
    vm.runInNewContext(script, {
        require(name) {
            assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
            return mocks[name];
        },
        hexo: {
            env: { cmd: command },
            extend: { filter: { register(name, callback) { filters.set(name, callback); } } }
        }
    }, { filename: 'fontawesome-subsetting.js' });
    return {
        filters,
        render: html => filters.get('after_render:html')(html),
        subsets() {
            filters.get('before_exit')();
            return generatedSubsets;
        }
    };
}

test('collects normal document icons and preserves stylesheet/preload rewriting', () => {
    const plugin = loadPlugin();
    const html = plugin.render('<link rel="stylesheet" href="/font-awesome.css" integrity="hash" crossorigin="anonymous"><i class="fa fa-home"></i><i class="fas fa-search"></i><i class="far fa-heart"></i><i class="fab fa-github"></i>');
    assert.deepEqual(plugin.subsets(), {
        solid: ['home', 'search'], regular: ['heart'], brands: ['github']
    });
    const dom = new JSDOM(html);
    const link = dom.window.document.querySelector('link[rel="stylesheet"]');
    assert.equal(link.getAttribute('href'), '/css/font-awesome.subset.css');
    assert.equal(link.hasAttribute('integrity'), false);
    assert.equal(link.hasAttribute('crossorigin'), false);
    assert.equal(dom.window.document.querySelectorAll('link[rel="preload"][as="font"]').length, 3);
    dom.window.close();
});

test('collects NexT search popup icons from template content without activating it', () => {
    const plugin = loadPlugin();
    const html = plugin.render('<template id="search-popup"><i class="fas fa-times-circle"></i><i class="fas fa-spinner"></i></template>');
    assert.deepEqual(plugin.subsets(), { solid: ['times-circle', 'spinner'] });
    const dom = new JSDOM(html);
    const document = dom.window.document;
    assert.equal(document.querySelector('.fa-spinner'), null);
    assert.equal(document.querySelector('#search-popup').content.querySelectorAll('i').length, 2);
    dom.window.close();
});

test('recursively collects nested and sibling templates across all font styles', () => {
    const plugin = loadPlugin();
    plugin.render('<template><i class="fas fa-search"></i><template><i class="far fa-heart"></i><template><i class="fab fa-github"></i></template></template></template><template><i class="fa fa-home"></i></template>');
    assert.deepEqual(plugin.subsets(), {
        solid: ['home', 'search'], regular: ['heart'], brands: ['github']
    });
});

test('accumulates icons across rendered pages and deduplicates repeated icons', () => {
    const plugin = loadPlugin();
    plugin.render('<i class="fas fa-search"></i><template><i class="fas fa-search"></i></template>');
    plugin.render('<template><i class="fas fa-spinner"></i><i class="fas fa-search"></i></template>');
    assert.deepEqual(plugin.subsets(), { solid: ['search', 'spinner'] });
});

test('continues to skip subsetting in server mode', () => {
    assert.equal(loadPlugin('server').filters.size, 0);
});


test('ignores foreign-namespace template elements without document fragments', () => {
    const plugin = loadPlugin();
    plugin.render('<svg><template></template></svg><template><i class="fas fa-spinner"></i></template>');
    assert.deepEqual(plugin.subsets(), { solid: ['spinner'] });
});
