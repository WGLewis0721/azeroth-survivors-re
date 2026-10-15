//! Pure touch-axis validation, kept independent of the browser and renderer for testing.
pub(crate) fn axes(x: f64, y: f64) -> [f32; 2] {
    if !x.is_finite() || !y.is_finite() {
        return [0.0, 0.0];
    }
    let x = x.clamp(-1.0, 1.0) as f32;
    let y = y.clamp(-1.0, 1.0) as f32;
    let length = x.hypot(y);
    if length < 0.05 {
        [0.0, 0.0]
    } else {
        [x / length.max(1.0), y / length.max(1.0)]
    }
}
#[cfg(test)]
mod tests {
    use super::axes;
    #[test]
    fn pressure_is_preserved() {
        assert_eq!(axes(0.5, 0.0), [0.5, 0.0]);
        assert_eq!(axes(0.0, -0.25), [0.0, -0.25]);
    }
    #[test]
    fn diagonal_is_limited() {
        let [x, y] = axes(1.0, 1.0);
        assert!((x.hypot(y) - 1.0).abs() < 0.0001);
        assert_eq!(axes(3.0, 0.0), [1.0, 0.0]);
    }
    #[test]
    fn invalid_axes_and_dead_zone_stop_movement() {
        assert_eq!(axes(f64::NAN, 1.0), [0.0, 0.0]);
        assert_eq!(axes(1.0, f64::INFINITY), [0.0, 0.0]);
        assert_eq!(axes(0.01, 0.01), [0.0, 0.0]);
    }
}
