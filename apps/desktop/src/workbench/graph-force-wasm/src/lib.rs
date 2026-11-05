use std::f64::consts::TAU;

const NODE_FIELDS: usize = 6;
const X: usize = 0;
const Y: usize = 1;
const VX: usize = 2;
const VY: usize = 3;
const FX: usize = 4;
const FY: usize = 5;
const NONE: u32 = u32::MAX;
const ALPHA_DECAY: f64 = 0.022_762_779_044_189_33;
const VELOCITY_DECAY: f64 = 0.6;
const CHARGE_DISTANCE_MIN_SQUARED: f64 = 30.0 * 30.0;
const BARNES_HUT_THETA_SQUARED: f64 = 0.81;
const COLLISION_DISTANCE: f64 = 120.0;
const COLLISION_DISTANCE_SQUARED: f64 = COLLISION_DISTANCE * COLLISION_DISTANCE;
const COLLISION_STRENGTH: f64 = 0.5;
const MAX_QUAD_DEPTH: u32 = 20;

#[derive(Clone, Copy)]
struct Quad {
    middle_x: f64,
    middle_y: f64,
    opening_distance_squared: f64,
    mass: f64,
    cx: f64,
    cy: f64,
    children: [u32; 4],
    start: u32,
    end: u32,
}

impl Default for Quad {
    fn default() -> Self {
        Self {
            middle_x: 0.0,
            middle_y: 0.0,
            opening_distance_squared: 0.0,
            mass: 0.0,
            cx: 0.0,
            cy: 0.0,
            children: [NONE; 4],
            start: 0,
            end: 0,
        }
    }
}

pub struct GraphSimulation {
    node_count: usize,
    link_count: usize,
    node_data: Vec<f64>,
    id_units: Vec<u16>,
    id_offsets: Vec<u32>,
    link_indices: Vec<u32>,
    link_parameters: Vec<f64>,
    force_x: Vec<f64>,
    force_y: Vec<f64>,
    point_indices: Vec<u32>,
    point_scratch: Vec<u32>,
    quads: Vec<Quad>,
    traversal: Vec<(u32, bool)>,
    cell_x: Vec<i32>,
    cell_y: Vec<i32>,
    next_in_cell: Vec<i32>,
    table_x: Vec<i32>,
    table_y: Vec<i32>,
    table_head: Vec<i32>,
    alpha: f64,
    alpha_target: f64,
    center_strength: f64,
    repel_strength: f64,
    link_strength: f64,
    link_distance: f64,
    ticks: u32,
}

impl GraphSimulation {
    fn new(node_count: usize, link_count: usize, id_unit_count: usize) -> Self {
        let table_size = (node_count.saturating_mul(4).max(16)).next_power_of_two();
        let mut node_data = vec![0.0; node_count.saturating_mul(NODE_FIELDS)];
        node_data[FX * node_count..(FX + 1) * node_count].fill(f64::NAN);
        node_data[FY * node_count..(FY + 1) * node_count].fill(f64::NAN);
        Self {
            node_count,
            link_count,
            node_data,
            id_units: vec![0; id_unit_count],
            id_offsets: vec![0; node_count + 1],
            link_indices: vec![0; link_count.saturating_mul(2)],
            link_parameters: vec![0.0; link_count.saturating_mul(2)],
            force_x: vec![0.0; node_count],
            force_y: vec![0.0; node_count],
            point_indices: (0..node_count as u32).collect(),
            point_scratch: vec![0; node_count],
            quads: Vec::with_capacity(node_count.saturating_mul(8).max(16)),
            traversal: Vec::with_capacity(node_count.saturating_mul(4).max(64)),
            cell_x: vec![0; node_count],
            cell_y: vec![0; node_count],
            next_in_cell: vec![-1; node_count],
            table_x: vec![0; table_size],
            table_y: vec![0; table_size],
            table_head: vec![-1; table_size],
            alpha: 1.0,
            alpha_target: 0.0,
            center_strength: 0.1,
            repel_strength: 10.0,
            link_strength: 1.0,
            link_distance: 250.0,
            ticks: 0,
        }
    }

    #[inline]
    fn node_value(&self, field: usize, index: usize) -> f64 {
        self.node_data[field * self.node_count + index]
    }

    #[inline]
    fn set_node_value(&mut self, field: usize, index: usize, value: f64) {
        self.node_data[field * self.node_count + index] = value;
    }

    fn id_range(&self, index: usize) -> std::ops::Range<usize> {
        self.id_offsets[index] as usize..self.id_offsets[index + 1] as usize
    }

    fn pair_hash(&self, first: usize, second: usize) -> u32 {
        let mut hash = 2_166_136_261_u32;
        for unit in self.id_range(first) {
            hash = (hash ^ self.id_units[unit] as u32).wrapping_mul(16_777_619);
        }
        hash = (hash ^ 0).wrapping_mul(16_777_619);
        for unit in self.id_range(second) {
            hash = (hash ^ self.id_units[unit] as u32).wrapping_mul(16_777_619);
        }
        hash
    }

    #[inline]
    fn jiggle_angle(&self, first: usize, second: usize) -> f64 {
        self.pair_hash(first, second) as f64 / u32::MAX as f64 * TAU
    }

    fn build_quad(
        &mut self,
        start: usize,
        end: usize,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        depth: u32,
    ) -> u32 {
        let quad_index = self.quads.len() as u32;
        self.quads.push(Quad::default());
        let middle_x = (x0 + x1) / 2.0;
        let middle_y = (y0 + y1) / 2.0;
        let width = x1 - x0;
        let count = end - start;
        let can_split = count > 1 && depth < MAX_QUAD_DEPTH;
        let mut mass = 0.0;
        let mut sum_x = 0.0;
        let mut sum_y = 0.0;

        if can_split {
            let mut counts = [0usize; 4];
            for point_offset in start..end {
                let point = self.point_indices[point_offset] as usize;
                let quadrant =
                    usize::from(self.node_value(X, point) >= middle_x)
                        + usize::from(self.node_value(Y, point) >= middle_y) * 2;
                counts[quadrant] += 1;
                mass += 1.0;
                sum_x += self.node_value(X, point);
                sum_y += self.node_value(Y, point);
            }

            let mut offsets = [start; 4];
            for quadrant in 1..4 {
                offsets[quadrant] = offsets[quadrant - 1] + counts[quadrant - 1];
            }
            let mut cursor = offsets;
            for point_offset in start..end {
                let point = self.point_indices[point_offset] as usize;
                let quadrant =
                    usize::from(self.node_value(X, point) >= middle_x)
                        + usize::from(self.node_value(Y, point) >= middle_y) * 2;
                self.point_scratch[cursor[quadrant]] = point as u32;
                cursor[quadrant] += 1;
            }
            self.point_indices[start..end].copy_from_slice(&self.point_scratch[start..end]);
            self.quads[quad_index as usize] = Quad {
                middle_x,
                middle_y,
                opening_distance_squared: width * width / BARNES_HUT_THETA_SQUARED,
                mass,
                cx: sum_x / mass,
                cy: sum_y / mass,
                children: [NONE; 4],
                start: start as u32,
                end: end as u32,
            };

            for quadrant in 0..4 {
                if counts[quadrant] == 0 {
                    continue;
                }
                let child_start = offsets[quadrant];
                let child_end = child_start + counts[quadrant];
                let right_side = quadrant & 1 != 0;
                let bottom_side = quadrant & 2 != 0;
                let child = self.build_quad(
                    child_start,
                    child_end,
                    if right_side { middle_x } else { x0 },
                    if bottom_side { middle_y } else { y0 },
                    if right_side { x1 } else { middle_x },
                    if bottom_side { y1 } else { middle_y },
                    depth + 1,
                );
                self.quads[quad_index as usize].children[quadrant] = child;
            }
            return quad_index;
        }

        for point_offset in start..end {
            let point = self.point_indices[point_offset] as usize;
            mass += 1.0;
            sum_x += self.node_value(X, point);
            sum_y += self.node_value(Y, point);
        }
        self.quads[quad_index as usize] = Quad {
            middle_x,
            middle_y,
            opening_distance_squared: width * width / BARNES_HUT_THETA_SQUARED,
            mass,
            cx: sum_x / mass,
            cy: sum_y / mass,
            children: [NONE; 4],
            start: start as u32,
            end: end as u32,
        };
        quad_index
    }

    fn build_tree(&mut self) -> Option<u32> {
        if self.node_count == 0 {
            return None;
        }
        let mut x0 = f64::INFINITY;
        let mut y0 = f64::INFINITY;
        let mut x1 = f64::NEG_INFINITY;
        let mut y1 = f64::NEG_INFINITY;
        for index in 0..self.node_count {
            let x = self.node_value(X, index);
            let y = self.node_value(Y, index);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        let extent = 1.0_f64.max(x1 - x0).max(y1 - y0);
        let pad = extent * 1e-6 + 1e-6;
        x0 -= pad;
        y0 -= pad;
        x1 = x0 + extent + pad * 2.0;
        y1 = y0 + extent + pad * 2.0;
        for (index, point) in self.point_indices.iter_mut().enumerate() {
            *point = index as u32;
        }
        self.quads.clear();
        Some(self.build_quad(0, self.node_count, x0, y0, x1, y1, 0))
    }

    fn add_charge_forces(&mut self) {
        if self.repel_strength == 0.0 || self.node_count == 0 {
            return;
        }
        let Some(root) = self.build_tree() else { return };
        let charge_alpha = -(self.repel_strength.powi(3)) * self.alpha;
        for target in 0..self.node_count {
            let target_x = self.node_value(X, target);
            let target_y = self.node_value(Y, target);
            self.traversal.clear();
            self.traversal.push((root, true));
            while let Some((quad_index, includes_target)) = self.traversal.pop() {
                let quad = self.quads[quad_index as usize];
                let has_children = quad.children.iter().any(|child| *child != NONE);
                if !has_children {
                    for point_offset in quad.start as usize..quad.end as usize {
                        let other = self.point_indices[point_offset] as usize;
                        if other == target {
                            continue;
                        }
                        let mut dx = self.node_value(X, other) - target_x;
                        let mut dy = self.node_value(Y, other) - target_y;
                        let mut distance_squared = dx * dx + dy * dy;
                        if distance_squared < 1e-12 {
                            let angle = self.jiggle_angle(target, other);
                            dx = angle.cos() * 1e-6;
                            dy = angle.sin() * 1e-6;
                            distance_squared = dx * dx + dy * dy;
                        }
                        let strength = charge_alpha / distance_squared.max(CHARGE_DISTANCE_MIN_SQUARED);
                        self.force_x[target] += dx * strength;
                        self.force_y[target] += dy * strength;
                    }
                    continue;
                }

                if includes_target {
                    let target_quadrant =
                        usize::from(target_x >= quad.middle_x)
                            + usize::from(target_y >= quad.middle_y) * 2;
                    for quadrant in 0..4 {
                        let child = quad.children[quadrant];
                        if child != NONE {
                            self.traversal.push((child, quadrant == target_quadrant));
                        }
                    }
                    continue;
                }

                let dx = quad.cx - target_x;
                let dy = quad.cy - target_y;
                let distance_squared = dx * dx + dy * dy;
                if quad.opening_distance_squared >= distance_squared {
                    for child in quad.children {
                        if child != NONE {
                            self.traversal.push((child, false));
                        }
                    }
                    continue;
                }

                let (dx, dy, distance_squared) = if distance_squared < 1e-12 {
                    (1e-3, -1e-3, 2e-6)
                } else {
                    (dx, dy, distance_squared)
                };
                let strength = charge_alpha * quad.mass
                    / distance_squared.max(CHARGE_DISTANCE_MIN_SQUARED);
                self.force_x[target] += dx * strength;
                self.force_y[target] += dy * strength;
            }
        }
    }

    #[inline]
    fn cell_hash(x: i32, y: i32) -> usize {
        let mut value = x as u32;
        value = (value ^ (y as u32).rotate_left(16)).wrapping_mul(0x9e37_79b1);
        (value ^ (value >> 16)) as usize
    }

    fn find_cell(&self, x: i32, y: i32) -> Option<usize> {
        let mask = self.table_head.len() - 1;
        let mut slot = Self::cell_hash(x, y) & mask;
        loop {
            let head = self.table_head[slot];
            if head == -1 {
                return None;
            }
            if self.table_x[slot] == x && self.table_y[slot] == y {
                return Some(slot);
            }
            slot = (slot + 1) & mask;
        }
    }

    fn add_collision_forces(&mut self) {
        if self.node_count < 2 {
            return;
        }
        self.table_head.fill(-1);
        for index in 0..self.node_count {
            let x = (self.node_value(X, index) / COLLISION_DISTANCE).floor() as i32;
            let y = (self.node_value(Y, index) / COLLISION_DISTANCE).floor() as i32;
            self.cell_x[index] = x;
            self.cell_y[index] = y;
            let mask = self.table_head.len() - 1;
            let mut slot = Self::cell_hash(x, y) & mask;
            loop {
                let head = self.table_head[slot];
                if head == -1 {
                    self.table_x[slot] = x;
                    self.table_y[slot] = y;
                    self.table_head[slot] = index as i32;
                    self.next_in_cell[index] = -1;
                    break;
                }
                if self.table_x[slot] == x && self.table_y[slot] == y {
                    self.next_in_cell[index] = head;
                    self.table_head[slot] = index as i32;
                    break;
                }
                slot = (slot + 1) & mask;
            }
        }

        const NEIGHBORS: [(i32, i32); 5] = [(0, 0), (1, 0), (0, 1), (1, 1), (-1, 1)];
        for left in 0..self.node_count {
            let first_x = self.node_value(X, left);
            let first_y = self.node_value(Y, left);
            let cell_x = self.cell_x[left];
            let cell_y = self.cell_y[left];
            for (neighbor_index, (offset_x, offset_y)) in NEIGHBORS.iter().enumerate() {
                let Some(slot) = self.find_cell(cell_x + offset_x, cell_y + offset_y) else {
                    continue;
                };
                let mut right = self.table_head[slot];
                while right >= 0 {
                    let right_index = right as usize;
                    right = self.next_in_cell[right_index];
                    if neighbor_index == 0 && right_index <= left {
                        continue;
                    }
                    let mut dx = self.node_value(X, right_index) - first_x;
                    let mut dy = self.node_value(Y, right_index) - first_y;
                    let mut distance_squared = dx * dx + dy * dy;
                    if distance_squared >= COLLISION_DISTANCE_SQUARED {
                        continue;
                    }
                    if distance_squared < 1e-12 {
                        let angle = self.jiggle_angle(left, right_index);
                        dx = angle.cos() * 1e-6;
                        dy = angle.sin() * 1e-6;
                        distance_squared = dx * dx + dy * dy;
                    }
                    let distance = distance_squared.sqrt();
                    let push = (COLLISION_DISTANCE - distance) / distance * COLLISION_STRENGTH;
                    self.force_x[left] -= dx * push * 0.5;
                    self.force_y[left] -= dy * push * 0.5;
                    self.force_x[right_index] += dx * push * 0.5;
                    self.force_y[right_index] += dy * push * 0.5;
                }
            }
        }
    }

    fn step_one(&mut self) -> bool {
        self.alpha += (self.alpha_target - self.alpha) * ALPHA_DECAY;
        self.ticks += 1;
        if self.alpha < 0.001 && self.alpha_target == 0.0 {
            return false;
        }
        self.force_x.fill(0.0);
        self.force_y.fill(0.0);
        let center = self.center_strength * self.alpha;
        for index in 0..self.node_count {
            self.force_x[index] -= self.node_value(X, index) * center;
            self.force_y[index] -= self.node_value(Y, index) * center;
        }
        self.add_charge_forces();
        self.add_collision_forces();

        let link_strength = self.link_strength * self.alpha;
        for link in 0..self.link_count {
            let source = self.link_indices[link * 2] as usize;
            let target = self.link_indices[link * 2 + 1] as usize;
            let mut dx = self.node_value(X, target) - self.node_value(X, source);
            let mut dy = self.node_value(Y, target) - self.node_value(Y, source);
            let mut distance = (dx * dx + dy * dy).sqrt();
            if distance < 1e-6 {
                let angle = self.jiggle_angle(source, target);
                dx = angle.cos() * 1e-6;
                dy = angle.sin() * 1e-6;
                distance = (dx * dx + dy * dy).sqrt();
            }
            let strength = link_strength / self.link_parameters[link * 2];
            let pull = (distance - self.link_distance) / distance * strength;
            let x = dx * pull;
            let y = dy * pull;
            let source_bias = self.link_parameters[link * 2 + 1];
            self.force_x[source] += x * source_bias;
            self.force_y[source] += y * source_bias;
            self.force_x[target] -= x * (1.0 - source_bias);
            self.force_y[target] -= y * (1.0 - source_bias);
        }

        for index in 0..self.node_count {
            let fx = self.node_value(FX, index);
            let fy = self.node_value(FY, index);
            if fx.is_finite() && fy.is_finite() {
                self.set_node_value(X, index, fx);
                self.set_node_value(Y, index, fy);
                self.set_node_value(VX, index, 0.0);
                self.set_node_value(VY, index, 0.0);
                continue;
            }
            let vx = (self.node_value(VX, index) + self.force_x[index]) * VELOCITY_DECAY;
            let vy = (self.node_value(VY, index) + self.force_y[index]) * VELOCITY_DECAY;
            let speed = (vx * vx + vy * vy).sqrt();
            let scale = if speed > 80.0 { 80.0 / speed } else { 1.0 };
            let vx = vx * scale;
            let vy = vy * scale;
            self.set_node_value(VX, index, vx);
            self.set_node_value(VY, index, vy);
            self.set_node_value(X, index, self.node_value(X, index) + vx);
            self.set_node_value(Y, index, self.node_value(Y, index) + vy);
        }
        true
    }
}

#[no_mangle]
pub extern "C" fn graph_create(node_count: u32, link_count: u32, id_unit_count: u32) -> *mut GraphSimulation {
    Box::into_raw(Box::new(GraphSimulation::new(
        node_count as usize,
        link_count as usize,
        id_unit_count as usize,
    )))
}

#[no_mangle]
pub unsafe extern "C" fn graph_destroy(simulation: *mut GraphSimulation) {
    if !simulation.is_null() {
        drop(Box::from_raw(simulation));
    }
}

#[no_mangle]
pub unsafe extern "C" fn graph_node_data_ptr(simulation: *mut GraphSimulation) -> *mut f64 {
    (*simulation).node_data.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn graph_id_units_ptr(simulation: *mut GraphSimulation) -> *mut u16 {
    (*simulation).id_units.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn graph_id_offsets_ptr(simulation: *mut GraphSimulation) -> *mut u32 {
    (*simulation).id_offsets.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn graph_link_indices_ptr(simulation: *mut GraphSimulation) -> *mut u32 {
    (*simulation).link_indices.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn graph_link_parameters_ptr(simulation: *mut GraphSimulation) -> *mut f64 {
    (*simulation).link_parameters.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn graph_set_forces(
    simulation: *mut GraphSimulation,
    center_strength: f64,
    repel_strength: f64,
    link_strength: f64,
    link_distance: f64,
) {
    let simulation = &mut *simulation;
    simulation.center_strength = center_strength;
    simulation.repel_strength = repel_strength;
    simulation.link_strength = link_strength;
    simulation.link_distance = link_distance;
}

#[no_mangle]
pub unsafe extern "C" fn graph_set_pin(
    simulation: *mut GraphSimulation,
    index: u32,
    x: f64,
    y: f64,
    pinned: u32,
) {
    let simulation = &mut *simulation;
    let index = index as usize;
    if index >= simulation.node_count {
        return;
    }
    let (x, y) = if pinned != 0 { (x, y) } else { (f64::NAN, f64::NAN) };
    simulation.set_node_value(FX, index, x);
    simulation.set_node_value(FY, index, y);
    if pinned != 0 {
        simulation.set_node_value(X, index, x);
        simulation.set_node_value(Y, index, y);
        simulation.set_node_value(VX, index, 0.0);
        simulation.set_node_value(VY, index, 0.0);
        simulation.alpha_target = 0.3;
    } else {
        simulation.alpha_target = 0.0;
    }
}

#[no_mangle]
pub unsafe extern "C" fn graph_reheat(simulation: *mut GraphSimulation, alpha: f64) {
    let simulation = &mut *simulation;
    let alpha = if alpha.is_finite() { alpha.clamp(0.0, 1.0) } else { 0.0 };
    simulation.alpha = simulation.alpha.max(alpha);
}

#[no_mangle]
pub unsafe extern "C" fn graph_set_alpha_target(simulation: *mut GraphSimulation, alpha_target: f64) {
    let simulation = &mut *simulation;
    simulation.alpha_target = if alpha_target.is_finite() {
        alpha_target.clamp(0.0, 1.0)
    } else {
        0.0
    };
}

#[no_mangle]
pub unsafe extern "C" fn graph_step(simulation: *mut GraphSimulation, iterations: u32) -> u32 {
    let simulation = &mut *simulation;
    let mut completed = 0;
    for _ in 0..iterations {
        completed += 1;
        if !simulation.step_one() {
            break;
        }
    }
    completed
}

#[no_mangle]
pub unsafe extern "C" fn graph_alpha(simulation: *const GraphSimulation) -> f64 {
    (*simulation).alpha
}

#[no_mangle]
pub unsafe extern "C" fn graph_tick_count(simulation: *const GraphSimulation) -> u32 {
    (*simulation).ticks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_nodes() -> GraphSimulation {
        let mut simulation = GraphSimulation::new(2, 1, 6);
        simulation.node_data[0] = -20.0;
        simulation.node_data[1] = 20.0;
        simulation.node_data[2] = 0.0;
        simulation.node_data[3] = 0.0;
        simulation.link_indices.copy_from_slice(&[0, 1]);
        simulation.link_parameters.copy_from_slice(&[1.0, 0.5]);
        simulation.id_offsets.copy_from_slice(&[0, 1, 2]);
        simulation.id_units.copy_from_slice(&[97, 98, 99, 0, 0, 0]);
        simulation
    }

    #[test]
    fn runs_three_hundred_ticks_and_keeps_positions_finite() {
        let mut simulation = two_nodes();
        for _ in 0..301 {
            if !simulation.step_one() { break; }
        }
        assert_eq!(simulation.ticks, 300);
        assert!(simulation.alpha <= 0.001_000_000_000_001);
        assert!(simulation.node_data[..4].iter().all(|value| value.is_finite()));
    }

    #[test]
    fn overlapping_nodes_are_jiggled_and_separated_without_nan() {
        let mut simulation = GraphSimulation::new(2, 0, 2);
        simulation.node_data[0] = 1.0;
        simulation.node_data[1] = 1.0;
        simulation.node_data[2] = 0.0;
        simulation.node_data[3] = 0.0;
        simulation.id_offsets.copy_from_slice(&[0, 1, 2]);
        simulation.id_units.copy_from_slice(&[97, 98]);
        simulation.step_one();
        assert!(simulation.node_data[..4].iter().all(|value| value.is_finite()));
        let dx = simulation.node_data[0] - simulation.node_data[1];
        let dy = simulation.node_data[2] - simulation.node_data[3];
        assert!(dx * dx + dy * dy > 0.0);
    }
}
