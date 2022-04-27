const fs = require('fs')
const { resolve } = require('path');
var request = require('request');
var HTMLParser = require('node-html-parser');
let RssParser = require('rss-parser');
var crypto = require('crypto');
const path = require('path')
const AppDao = require('./dao.js');
const Utils = require('./utils');
var moment = require('moment');

function get_rss_page(link) {
    return AppDao.db().get(`SELECT * FROM pages WHERE link = ?`, link);
}

function gen_image_name(image_uri) {
    let image_dir = "./pages/images";
    if (!fs.existsSync(image_dir)) {
        fs.mkdir(image_dir, (err) => {
            if (err) {
                throw err;
            }
        });
    }
    let extname = image_uri.split('.').pop().split(/\#|\?/)[0];
    let digest = crypto.createHash('sha256').update(image_uri)
        .digest('hex').substr(0, 15);
    return `${image_dir}/${digest}.${extname}`;
}

function isValidHttpUrl(string) {
    let url;
    try {
        url = new URL(string);
    } catch (_) {
        return false;
    }

    return url.protocol === "http:" || url.protocol === "https:";
}

async function preprocess_image(content, feed_url) {
    let url = (new URL(feed_url));
    let domain = url.hostname;

    let html = HTMLParser.parse(content);
    let res = html.toString();
    let imgs = html.querySelectorAll("img");
    for (let img of imgs) {
        let attrs = img.attributes;
        let src = attrs['src'];
        let image_uri = isValidHttpUrl(src) ? src : `${url.protocol}//${domain}${src}`;
        let new_image_path = gen_image_name(image_uri);
        if (isValidHttpUrl(image_uri) && image_uri.length <= 200) {
            let fullpath = resolve(new_image_path);
            image_uri = image_uri.replace("https://", "http://");
            console.log("begin down load: ", image_uri, " to ", fullpath);
            if (!fs.existsSync(fullpath)) {
                // TODO: download.Image how to follow 301?
                // Use wget now to follow redirects
                Utils.downLoadImage(image_uri, fullpath);
            }
            if (fs.existsSync(fullpath)) {
                let new_image = new_image_path.replace("./", "/");
                res = res.replace("src=\"" + src + "\"", "src=\"" + new_image + "\"");
            }
        }
    }
    return res;
}

function extract_html(html, keyword) {
    let res = "";
    let html_obj = HTMLParser.parse(html);
    let divs = html_obj.querySelectorAll(keyword);
    divs.sort((a, b) => {
        return a.toString().length - b.toString().length;
    });
    if (divs.length > 0) {
        res = divs[0].toString();
    }
    return res;
}

function remove_elems(html, keywords) {
    let html_obj = HTMLParser.parse(html);
    for (let keyword of keywords) {
        let divs = html_obj.querySelectorAll(keyword);
        for (let div of divs) {
            div.remove();
        }
    }
    return html_obj.removeWhitespace().toString();
}

function transform_html(html) {
    let body = extract_html(html, "article");
    if (body == "") {
        body = extract_html(html, "body");
    }
    if (body == "") {
        body = html;
    }
    let keywords = ["footer", "header", "script", "style", "comments", "nav"];
    body = remove_elems(body, keywords);
    return body;
}

function fetch_page_content(link) {
    if (isValidHttpUrl(link)) {
        return new Promise((resolve, reject) => {
            request(link, function(error, response, body) {
                if (!error && response.statusCode == 200) {
                    resolve(transform_html(body));
                } else {
                    reject(error);
                }
            });
        });
    }
}

async function fetchFeed(feed_url) {
    let res = [];
    let feed = null;
    let parser = new RssParser();
    try {
        feed = await parser.parseURL(feed_url);
    } catch (e) {
        feed_url = feed_url.replace("https://", "http://");
        feed = await parser.parseURL(feed_url);
    }
    for (let item of feed.items) {
        res.push(item);
        let pre = get_rss_page(item.link)[0];
        if (pre == undefined) {
            let sql = "INSERT INTO pages (title, link, website, publish_datetime, readed, source) values (?, ?, ?, ?, ?, ?)";
            let pubDate = moment(item.pubDate).format("YYYY-MM-DD HH:mm:ss");
            AppDao.db().run(
                sql, [item.title, item.link, item.link, pubDate, 0, feed_url]);
            let page = get_rss_page(item.link)[0];
            try {
                let html = await fetch_page_content(item.link);
                //console.log(html);
                let content = item.content;
                //console.log(item);
                if (content == undefined ||
                    html.length > (content.length * 4) ||
                    (html.indexOf(item.title) != -1) ||
                    (html.indexOf("<audio") != -1) ||
                    (html.indexOf("<video") != -1) ||
                    (html.indexOf("<code>") != -1)) {
                    content = html;
                }
                //console.log(item);
                content = await preprocess_image(content, feed_url);
                if (!fs.existsSync(resolve("./pages"))) {
                    fs.mkdirSync(resolve("./pages"));
                }
                fs.writeFileSync(path.resolve(`./pages/${page.id}.html`), content);
                console.log("saved: %d for link %s", page.id, item.link);
            } catch (e) {
                AppDao.db().run("DELETE FROM pages WHERE id = ?", [page.id]);
                console.log(e);
            }
        }
    }
    return res;
}

async function updateRss(feed_conf) {
    let content = fs.readFileSync(feed_conf, 'utf-8');
    let feeds = content.split(/\r?\n/);

    //feeds.forEach(async feed => {
    for (let feed of feeds) {
        try {
            console.log("fetching: ", feed);
            let res = await fetchFeed(feed);
            //console.log(res);
        } catch (e) {
            console.log("error: ", e);
        }
    }
    //});
}

module.exports = {
    fetchFeed,
    updateRss
}