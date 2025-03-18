const jsdom = require('jsdom');
const fas = require('fontawesome-subset');
const fs = require('fs');
const { PurgeCSS} = require('purgecss');
const deasync = require('deasync');

const subsets = {
    "fa": {
        style: "solid",
        icons: new Set()
    },
    "fas": {
        style: "solid",
        icons: new Set()
    },
    "far": {
        style: "regular",
        icons: new Set()
    },
    "fab": {
        style: "brands",
        icons: new Set()
    },
}

const fontAwesomeCss = fs.readFileSync('./node_modules/@fortawesome/fontawesome-free/css/all.min.css', 'utf-8');

hexo.extend.filter.register('after_render:html', (html, data) => {
    const dom = new jsdom.JSDOM(html);
    const document = dom.window.document;
    const faClasses = new Set();
    for (const [fsStyle, _] of Object.entries(subsets)) {
        document.querySelectorAll(`.${fsStyle}`).forEach(e => {
            e.classList.forEach(cls => {
                if (cls.startsWith('fa') && cls.length > 2) {
                    subsets[fsStyle].icons.add(cls.slice(3));
                    faClasses.add(cls);
                }
            })
        })
    }

    document.querySelectorAll('link[rel="stylesheet"]').forEach(e => {
        if (e.href.includes('font-awesome')) {
            e.remove();
        }
    })
    let purgedResult = null;
    new PurgeCSS().purge({
        content: [
            {
                raw: html,
                extension: "html"
            }
        ],
        css: [
            {
                raw: fontAwesomeCss,
                extension: "css"
            }
        ]
    }).then((e) => {
        purgedResult = e;
    });
    deasync.loopWhile(() => purgedResult === null);
    const purgedCss = purgedResult[0].css;

    const inlineFontAwesomeCss = document.createElement('style');
    inlineFontAwesomeCss.textContent = purgedCss;
    document.head.appendChild(inlineFontAwesomeCss);

    return dom.serialize();
});

hexo.extend.filter.register('before_exit', () => {
    const subsetsInput = {};
    for (const [_, value] of Object.entries(subsets)) {
        for (const icon of value.icons) {
            if (!subsetsInput[value.style]) {
                subsetsInput[value.style] = [];
            }
            subsetsInput[value.style].push(icon);
        }
    }
    fas.fontawesomeSubset(
        subsetsInput,
        'public/webfonts',
        { targetFormats: ['woff2'] }
    );
});
