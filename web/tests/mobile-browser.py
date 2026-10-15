"""Real Chromium touch/UI checks. Requires Python Playwright and Chromium.
Runs only the DOM/bridge contract, not the Rust game or its external assets.
"""
from pathlib import Path
import functools
import http.server
import json
import threading
from playwright.sync_api import sync_playwright

web = Path(__file__).resolve().parents[1]
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(web)))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
artifacts = Path('/tmp/azeroth-mobile-validation')
artifacts.mkdir(exist_ok=True)
state = dict(phase='Menu', sequence=0, classes=[dict(name=n) for n in ['Warrior','Paladin','Hunter','Rogue','Priest','Shaman','Mage','Warlock','Druid']],
             maps=[dict(name=n) for n in ['Elwynn Forest','Durotar','Naxxramas']], looks=[dict(race=1,sex=0),dict(race=1,sex=1)],
             selectedClass=0,selectedLook=0,selectedMap=0,level=5,hp=94,maxHp=120,xp=20,xpNeeded=50,elapsed=125,kills=42,
             loading=False,mobility=dict(name='Charge',cd=0,learned=True),offers=[],won=False)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        for width,height in [(375,667),(390,844),(430,932),(320,568),(844,390)]:
            context = browser.new_context(viewport=dict(width=width,height=height), is_mobile=True, has_touch=True, device_scale_factor=3)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/tests/mobile-fixture.html?mobile=1')
            page.evaluate('(state) => { window.__survivorsMobileState = state; window.mobile.render(); }', state)
            assert page.locator('#m-title').inner_text() == 'Choose your survivor'
            assert page.locator('[data-action="start"]').is_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            for selector in ['[data-select="selectClass"]','[data-select="selectLook"]','[data-select="selectMap"]','[data-action="start"]']:
                box = page.locator(selector).bounding_box()
                assert box['width'] >= 44 and box['height'] >= 44, (selector,box)
                assert box['x'] >= 0 and box['x']+box['width'] <= width+1
            if width == 390: page.screenshot(path=str(artifacts/'menu.png'))
            page.locator('[data-select="selectClass"]').select_option('6')
            assert page.evaluate('window.mobile.input.action') == 'selectClass'
            assert page.evaluate('window.mobile.input.index') == 6
            # The snapshot acknowledges receipt before another command is accepted.
            page.evaluate('window.__survivorsMobileState.sequence = window.mobile.input.sequence; window.mobile.render()')
            page.locator('[data-action="start"]').click()
            assert page.evaluate('window.mobile.input.action') == 'start'
            page.evaluate("window.__survivorsMobileState.phase='Playing'; window.__survivorsMobileState.sequence=window.mobile.input.sequence; window.mobile.render()")
            assert page.locator('.m-controls').is_visible()
            assert page.locator('[data-time]').inner_text() == '02:05'
            stick = page.locator('.m-stick').bounding_box()
            assert stick['y']+stick['height'] <= height+1
            cx,cy = stick['x']+stick['width']/2,stick['y']+stick['height']/2
            cdp = context.new_cdp_session(page)
            def touch(kind, points):
                cdp.send('Input.dispatchTouchEvent', dict(type=kind,touchPoints=points))
            touch('touchStart',[dict(x=cx,y=cy)])
            touch('touchMove',[dict(x=cx-48,y=cy-30)])
            vector = page.evaluate('({x:window.mobile.input.x,y:window.mobile.input.y})')
            assert vector['x'] < -.5 and vector['y'] < -.3, vector
            touch('touchEnd',[])
            assert page.evaluate('window.mobile.input.x === 0 && window.mobile.input.y === 0')
            # Touch cancellation and browser interruptions must release movement.
            touch('touchStart',[dict(x=cx+35,y=cy)])
            touch('touchCancel',[])
            assert page.evaluate('window.mobile.input.x === 0 && window.mobile.input.y === 0')
            before_pause = page.evaluate('window.mobile.input.pauseSequence')
            page.evaluate("window.dispatchEvent(new Event('blur'))")
            assert page.evaluate('window.mobile.input.hidden')
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            assert not page.evaluate('window.mobile.input.hidden')
            assert page.evaluate('window.mobile.input.pauseSequence') == before_pause + 1
            if width == 390: page.screenshot(path=str(artifacts/'playing-controls.png'))
            page.locator('[data-action="mobility"]').click()
            assert page.evaluate('window.mobile.input.action') == 'mobility'
            page.evaluate("window.__survivorsMobileState.sequence=window.mobile.input.sequence; window.__survivorsMobileState.phase='LevelUp'; window.__survivorsMobileState.offers=[{title:'Frost Nova',description:'Freeze nearby enemies',details:'Damage 20 » 26'},{title:'Arcane power',description:'Make every spell stronger',details:'Damage +15%'},{title:'Restoration',description:'Recover your health',details:'Heal 40 HP'}]; window.mobile.render()")
            assert page.locator('.m-offer').count() == 3
            page.locator('.m-offer').last.scroll_into_view_if_needed()
            assert page.locator('.m-offer').last.is_visible()
            if width == 390: page.screenshot(path=str(artifacts/'upgrades.png'))
            page.locator('.m-offer').last.click()
            assert page.evaluate('window.mobile.input.action') == 'pick'
            assert page.evaluate('window.mobile.input.index') == 2
            page.evaluate("window.__survivorsMobileState.phase='Paused'; window.__survivorsMobileState.sequence=window.mobile.input.sequence; window.mobile.render()")
            page.locator('[data-hand]').click()
            page.evaluate("window.__survivorsMobileState.phase='Playing'; window.mobile.render()")
            assert page.locator('.m-stick').bounding_box()['x'] < width/2
            page.evaluate("window.__survivorsMobileState.mobility.cd=3; window.mobile.render()")
            assert page.locator('.m-escape').is_disabled()
            assert not errors, errors
            print(f'PASS {width}x{height}: layout, thumb targets, touch movement/release/cancel, lifecycle, commands, upgrades, handedness, cooldown')
            context.close()
        browser.close()
finally:
    server.shutdown()
print(f'Screenshots: {artifacts}')
