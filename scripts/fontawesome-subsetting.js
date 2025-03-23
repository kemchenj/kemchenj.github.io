const jsdom = require('jsdom');
const fas = require('fontawesome-subset');
const fs = require('fs');
const { PurgeCSS} = require('purgecss');

if (hexo.env.cmd !== 'server') {
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

    hexo.extend.filter.register('after_render:html', (html, data) => {
        const dom = new jsdom.JSDOM(html);
        const document = dom.window.document;
        for (const [fsStyle, _] of Object.entries(subsets)) {
            document.querySelectorAll(`.${fsStyle}`).forEach(e => {
                e.classList.forEach(cls => {
                    if (cls.startsWith('fa') && cls.length > 3) {
                        subsets[fsStyle].icons.add(cls.slice(3));
                    }
                })
            })
        }

        document.querySelectorAll('link[rel="stylesheet"]').forEach(e => {
            if (e.href.includes('font-awesome')) {
                e.href = "/css/font-awesome.min.css";
                e.removeAttribute('crossorigin');
                e.removeAttribute('integrity');
            }
        })

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

        new PurgeCSS().purge({
            content: ['public/**/*.html'],
            css: ['./node_modules/@fortawesome/fontawesome-free/css/all.min.css']
        }).then((result) => {
            const purgedCss = result[0].css;
            fs.writeFileSync('./public/css/font-awesome.min.css', purgedCss);
        });
    });
}
