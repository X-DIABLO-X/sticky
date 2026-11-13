use uiautomation::core::UIAutomation;
use uiautomation::UIElement;
use crate::error::{AppError, Result};
use super::{A11yBackend, A11yNode, A11yTree};

pub struct WindowsA11yBackend {
    automation: UIAutomation,
}

impl WindowsA11yBackend {
    pub fn new() -> Result<Self> {
        let automation = UIAutomation::new()
            .map_err(|e| AppError::A11y(format!("Failed to initialize UIAutomation: {}", e)))?;
        Ok(Self { automation })
    }

    fn parse_element(&self, element: &UIElement, depth: usize, max_depth: usize) -> A11yNode {
        let name = element.get_name().unwrap_or_default();
        let class_name = element.get_classname().unwrap_or_default();
        let control_type = element.get_control_type()
            .map(|t| format!("{:?}", t))
            .unwrap_or_else(|_| class_name.clone());

        let rect = element.get_bounding_rectangle().unwrap_or_default();
        let bbox = [
            rect.get_left(),
            rect.get_top(),
            rect.get_width(),
            rect.get_height(),
        ];

        let is_interactive = matches!(
            control_type.as_str(),
            "Button" | "Edit" | "MenuItem" | "Hyperlink" | "CheckBox" | "RadioButton" | "ComboBox" | "TabItem" | "ListItem"
        );

        let mut children = Vec::new();
        if depth < max_depth {
            if let Ok(walker) = self.automation.get_control_view_walker() {
                if let Ok(first_child) = walker.get_first_child(element) {
                    let mut curr = Some(first_child);
                    while let Some(child) = curr {
                        children.push(self.parse_element(&child, depth + 1, max_depth));
                        curr = walker.get_next_sibling(&child).ok();
                    }
                }
            }
        }

        A11yNode {
            id: format!("{:p}", element as *const _),
            role: control_type,
            name,
            value: None,
            bbox,
            interactive: is_interactive,
            children,
        }
    }
}

impl A11yBackend for WindowsA11yBackend {
    fn get_focused_window_tree(&self, max_depth: usize) -> Result<A11yTree> {
        let focused = self.automation.get_focused_element()
            .map_err(|e| AppError::A11y(format!("Failed to get focused element: {}", e)))?;

        let window_title = focused.get_name().unwrap_or_else(|_| "Unknown Window".to_string());
        let root = self.parse_element(&focused, 0, max_depth);

        Ok(A11yTree {
            window_title,
            root,
        })
    }
}
