# Vendored libraries

These files are copied verbatim from npm (via jsDelivr) so the site has no runtime dependency on a CDN.
To upgrade, change the version numbers below and re-run the commands.

| Library | Version | License | Files |
|---|---|---|---|
| [EventCalendar](https://github.com/vkurko/calendar) | 5.18.1 | MIT | `event-calendar.min.js`, `event-calendar.min.css` |
| [marked](https://github.com/markedjs/marked) | 18.1.2 | MIT | `marked.umd.js` |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | Apache-2.0 / MPL-2.0 | `purify.min.js` |

```sh
cd site/vendor
curl -sSfO https://cdn.jsdelivr.net/npm/@event-calendar/build@5.18.1/dist/event-calendar.min.js
curl -sSfO https://cdn.jsdelivr.net/npm/@event-calendar/build@5.18.1/dist/event-calendar.min.css
curl -sSfO https://cdn.jsdelivr.net/npm/marked@18.1.2/lib/marked.umd.js
curl -sSfO https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js
sed -i.bak '/sourceMappingURL/d' *.js && rm -f *.bak   # source maps are not vendored
```
