pub mod linux;
pub mod macos;
#[cfg(windows)]
pub mod windows;

use serde::{Deserialize, Serialize};
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yNode {
    pub id: String,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub bbox: [i32; 4], // [x, y, width, height]
    pub interactive: bool,
    pub children: Vec<A11yNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yTree {
    pub window_title: String,
    pub root: A11yNode,
}

pub trait A11yBackend {
    fn get_focused_window_tree(&self, max_depth: usize) -> Result<A11yTree>;
}

impl A11yNode {
    /// Flatten interactive elements for efficient LLM context injection
    pub fn collect_interactive(&self, out: &mut Vec<A11yNodeCompact>) {
        if self.interactive && (!self.name.is_empty() || self.value.is_some()) {
            out.push(A11yNodeCompact {
                id: self.id.clone(),
                role: self.role.clone(),
                name: self.name.clone(),
                value: self.value.clone(),
                bbox: self.bbox,
            });
        }
        for child in &self.children {
            child.collect_interactive(out);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yNodeCompact {
    pub id: String,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub bbox: [i32; 4],
}

pub fn get_focused_window_tree(max_depth: usize) -> Result<A11yTree> {
    #[cfg(windows)]
    {
        windows::WindowsA11yBackend::new()?.get_focused_window_tree(max_depth)
    }
    #[cfg(target_os = "linux")]
    {
        linux::LinuxA11yBackend::new().get_focused_window_tree(max_depth)
    }
    #[cfg(target_os = "macos")]
    {
        macos::MacosA11yBackend::new().get_focused_window_tree(max_depth)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        Ok(A11yTree {
            window_title: "Unsupported OS".to_string(),
            root: A11yNode {
                id: "0".to_string(),
                role: "Unknown".to_string(),
                name: "Unsupported".to_string(),
                value: None,
                bbox: [0, 0, 0, 0],
                interactive: false,
                children: vec![],
            },
        })
    }
}
