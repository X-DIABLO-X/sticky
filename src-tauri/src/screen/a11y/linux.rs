use crate::error::Result;
use super::{A11yBackend, A11yNode, A11yTree};

pub struct LinuxA11yBackend;

impl LinuxA11yBackend {
    pub fn new() -> Self {
        Self
    }
}

impl A11yBackend for LinuxA11yBackend {
    fn get_focused_window_tree(&self, _max_depth: usize) -> Result<A11yTree> {
        Ok(A11yTree {
            window_title: "Active Linux Window".to_string(),
            root: A11yNode {
                id: "linux_root".to_string(),
                role: "Window".to_string(),
                name: "Active Window".to_string(),
                value: None,
                bbox: [0, 0, 1920, 1080],
                interactive: false,
                children: vec![],
            },
        })
    }
}
