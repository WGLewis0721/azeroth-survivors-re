//! Opt-in, wasm-only touch bridge. DOM controls own presentation; game rules remain here.
use super::{data, hero, hud, menu, mobility, Phase, Rng, Run, Selection};
use bevy::prelude::*;
use js_sys::{Array, Object, Reflect};
use wasm_bindgen::JsValue;

#[derive(Resource)]
pub(super) struct Input {
    pub active: bool,
    pub direction: Vec3,
    pub jump: bool,
    pub mobility: bool,
    facing: Vec3,
    sequence: f64,
    last_pause_sequence: f64,
}
impl Default for Input {
    fn default() -> Self {
        Self {
            active: false,
            direction: Vec3::ZERO,
            jump: false,
            mobility: false,
            facing: Vec3::NEG_Z,
            sequence: -1.0,
            last_pause_sequence: 0.0,
        }
    }
}
fn get(value: &JsValue, key: &str) -> JsValue {
    Reflect::get(value, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}
fn source() -> JsValue {
    web_sys::window()
        .map(|w| get(w.as_ref(), "__survivorsMobileInput"))
        .unwrap_or(JsValue::UNDEFINED)
}
pub(super) fn active() -> bool {
    get(&source(), "active").as_bool() == Some(true)
}
fn set(object: &Object, key: &str, value: impl Into<JsValue>) {
    let _ = Reflect::set(object, &JsValue::from_str(key), &value.into());
}
fn analog(x: f64, y: f64) -> Vec3 {
    let [x, y] = super::mobile_input::axes(x, y);
    Vec3::new(x, 0.0, y)
}
pub(super) fn plugin(app: &mut App) {
    app.init_resource::<Input>()
        .add_systems(
            Update,
            read.before(hero::aim_cursor)
                .in_set(benilla_world::schedule::WorldStage::Input),
        )
        .add_systems(Update, (hide_ui, publish).chain().after(hud::show_panels));
}
#[allow(clippy::too_many_arguments)]
fn read(
    mut input: ResMut<Input>,
    phase: Res<State<Phase>>,
    mut next: ResMut<NextState<Phase>>,
    mut selection: ResMut<Selection>,
    mut run: ResMut<Run>,
    mut offer: ResMut<hud::Offer>,
    mut rng: ResMut<Rng>,
    creatures: Option<Res<crate::entities::Creatures>>,
    hero: Query<&Transform, With<hero::Hero>>,
    mut aim: ResMut<hero::AimPoint>,
    loading: Res<crate::loading_screen::LoadingScreen>,
) {
    let value = source();
    input.active = get(&value, "active").as_bool() == Some(true);
    input.jump = false;
    input.mobility = false;
    input.direction = Vec3::ZERO;
    if !input.active {
        return;
    }
    // A persistent counter survives hide/show cycles completed between animation frames.
    // It is independent of action acknowledgments, so lifecycle events cannot overwrite picks.
    if let Some(sequence) = get(&value, "pauseSequence")
        .as_f64()
        .filter(|n| n.is_finite() && *n > input.last_pause_sequence)
    {
        input.last_pause_sequence = sequence;
        if *phase.get() == Phase::Playing {
            next.set(Phase::Paused);
        }
        return;
    }
    let hidden = get(&value, "hidden").as_bool() == Some(true);
    if hidden {
        if *phase.get() == Phase::Playing {
            next.set(Phase::Paused);
        }
        // Discard commands queued before returning to the page.
        input.sequence = get(&value, "sequence")
            .as_f64()
            .filter(|n| n.is_finite())
            .unwrap_or(input.sequence);
        return;
    }
    if !loading.covering() {
        input.direction = analog(
            get(&value, "x").as_f64().unwrap_or(0.0),
            get(&value, "y").as_f64().unwrap_or(0.0),
        );
    }
    if input.direction != Vec3::ZERO {
        input.facing = input.direction.normalize();
    }
    if let Ok(tf) = hero.single() {
        aim.0 = Some(tf.translation + input.facing * 30.0);
    }
    let sequence = get(&value, "sequence").as_f64().unwrap_or(-1.0);
    if !sequence.is_finite() || sequence <= input.sequence {
        return;
    }
    input.sequence = sequence;
    let index = get(&value, "index")
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
        .map(|n| n as usize);
    let action = get(&value, "action").as_string().unwrap_or_default();
    match (action.as_str(), *phase.get()) {
        ("selectClass", Phase::Menu) => {
            if let (Some(c), Some(creatures)) = (
                index.filter(|&i| i < data::CLASSES.len()),
                creatures.as_deref(),
            ) {
                let looks = hud::looks_for(&data::CLASSES[c], creatures);
                if !looks.is_empty() {
                    let current = selection
                        .look
                        .and_then(|l| selection.looks.get(l))
                        .map(|&(_, r, s)| (r, s));
                    let look = looks
                        .iter()
                        .position(|&(_, r, s)| Some((r, s)) == current)
                        .unwrap_or(0);
                    selection.class = Some(c);
                    selection.looks = looks;
                    selection.look = Some(look);
                    selection.version += 1;
                    menu::save_pick(&selection);
                }
            }
        }
        ("selectLook", Phase::Menu) => {
            if let Some(i) = index.filter(|&i| i < selection.looks.len()) {
                selection.look = Some(i);
                selection.version += 1;
                menu::save_pick(&selection);
            }
        }
        ("selectMap", Phase::Menu) => {
            if let Some(i) = index.filter(|&i| i < data::MAPS.len()) {
                selection.map = i;
                selection.version += 1;
                menu::save_pick(&selection);
            }
        }
        ("start", Phase::Menu) if !loading.covering() => {
            if hud::start_run(&mut run, &mut selection) {
                next.set(Phase::Playing);
            }
        }
        ("pause", Phase::Playing) => next.set(Phase::Paused),
        ("resume", Phase::Paused) => next.set(Phase::Playing),
        ("menu", Phase::Paused | Phase::GameOver) => next.set(Phase::Menu),
        ("pick", Phase::LevelUp) => {
            if let Some(i) = index {
                hud::pick(i, &mut run, &mut offer, &mut rng, &mut next);
            }
        }
        ("mobility", Phase::Playing) if !loading.covering() => input.mobility = true,
        ("jump", Phase::Playing) if !loading.covering() => input.jump = true,
        _ => {}
    }
}
fn hide_ui(
    input: Res<Input>,
    mut roots: Query<
        (&mut Visibility, &mut Node),
        Or<(
            With<hud::MenuRoot>,
            With<hud::HudRoot>,
            With<hud::LevelUpRoot>,
            With<hud::PauseRoot>,
            With<hud::OverRoot>,
        )>,
    >,
) {
    if input.active {
        for (mut visibility, mut node) in &mut roots {
            *visibility = Visibility::Hidden;
            node.display = Display::None;
        }
    }
}
#[allow(clippy::too_many_arguments)]
fn publish(
    time: Res<Time<Real>>,
    mut last: Local<f32>,
    input: Res<Input>,
    phase: Res<State<Phase>>,
    selection: Res<Selection>,
    run: Res<Run>,
    offer: Res<hud::Offer>,
    spells: Option<Res<crate::ui_action::Spells>>,
    loading: Res<crate::loading_screen::LoadingScreen>,
) {
    if !input.active || time.elapsed_secs() - *last < 0.1 {
        return;
    }
    *last = time.elapsed_secs();
    let state = Object::new();
    set(&state, "sequence", input.sequence);
    set(&state, "phase", format!("{:?}", phase.get()));
    let classes = Array::new();
    for c in data::CLASSES {
        let o = Object::new();
        set(&o, "name", c.name);
        classes.push(&o);
    }
    set(&state, "classes", classes);
    let maps = Array::new();
    for m in data::MAPS {
        let o = Object::new();
        set(&o, "name", m.name);
        maps.push(&o);
    }
    set(&state, "maps", maps);
    let looks = Array::new();
    for &(_, race, sex) in &selection.looks {
        let o = Object::new();
        set(&o, "race", u32::from(race));
        set(&o, "sex", u32::from(sex));
        looks.push(&o);
    }
    set(&state, "looks", looks);
    set(
        &state,
        "selectedClass",
        selection
            .class
            .map(|i| JsValue::from_f64(i as f64))
            .unwrap_or(JsValue::NULL),
    );
    set(
        &state,
        "selectedLook",
        selection
            .look
            .map(|i| JsValue::from_f64(i as f64))
            .unwrap_or(JsValue::NULL),
    );
    set(&state, "selectedMap", selection.map as u32);
    set(&state, "level", run.level);
    set(&state, "hp", run.hp);
    set(&state, "maxHp", run.stats().max_hp);
    set(&state, "xp", run.xp);
    set(&state, "xpNeeded", data::xp_to_next(run.level));
    set(&state, "elapsed", run.elapsed);
    set(&state, "kills", run.kills);
    set(&state, "won", run.won);
    set(
        &state,
        "banner",
        run.banner.as_ref().map_or("", |(text, _)| text.as_str()),
    );
    set(&state, "loading", loading.covering());
    let movement = Object::new();
    set(
        &movement,
        "name",
        mobility::for_class(run.class.id).map_or("Mobility", |m| m.name),
    );
    set(&movement, "cd", run.mobile.cd);
    set(&movement, "learned", run.mobility().is_some());
    set(&state, "mobility", movement);
    let offers = Array::new();
    for &choice in offer.choices() {
        let card = hud::describe_card(choice, &run, spells.as_deref());
        let o = Object::new();
        set(&o, "title", card.name);
        set(&o, "description", card.tag);
        set(&o, "details", card.desc);
        offers.push(&o);
    }
    set(&state, "offers", offers);
    if let Some(window) = web_sys::window() {
        let _ = Reflect::set(
            window.as_ref(),
            &JsValue::from_str("__survivorsMobileState"),
            &state,
        );
    }
}
