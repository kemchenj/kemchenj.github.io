const jsdom = require('jsdom');

hexo.extend.filter.register('after_render:html', (html, data) => {
    const dom = new jsdom.JSDOM(html);
    const document = dom.window.document;

    document.querySelectorAll('img[class="site-author-image"]').forEach(e => {
        e.width = 120;
        e.height = 120;
    })

    return dom.serialize();
});
