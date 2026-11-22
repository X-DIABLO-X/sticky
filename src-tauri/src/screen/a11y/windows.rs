use uiautomation::core::UIAutomation;
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::UIElement;
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use crate::error::{AppError, Result};
use super::{A11yBackend, A11yNode, A11yTree};

const MAX_A11Y_NODES: usize = 250;

pub struct WindowsA11yBackend {
    automation: UIAutomation,
}

impl WindowsA11yBackend {
    pub fn new() -> Result<Self> {
        let automation = UIAutomation::new()
            .map_err(|e| AppError::A11y(format!("Failed to initialize UIAutomation: {}", e)))?;
        Ok(Self { automation })
    }

    fn resolve_target_window(&self) -> Result<UIElement> {
        let fg_hwnd = unsafe { GetForegroundWindow() };
        let fg_is_valid = !fg_hwnd.0.is_null();

        if fg_is_valid {
            // uiautomation 0.6.5 wraps windows 0.51 HWND privately inside Handle without From<isize>,
            // while this crate uses windows 0.58 HWND(*mut c_void). Look up the foreground top-level
            // window via UIProperty::NativeWindowHandle (VT_I4) on the desktop root's direct children.
            if let Ok(desktop) = self.automation.get_root_element() {
                if let Ok(cond) = self.automation.create_property_condition(
                    UIProperty::NativeWindowHandle,
                    Variant::from(fg_hwnd.0 as isize as i32),
                    None,
                ) {
                    if let Ok(window_el) = desktop.find_first(TreeScope::Children, &cond) {
                        return Ok(window_el);
                    }
                }
            }
        }

        let focused = self
            .automation
            .get_focused_element()
            .map_err(|e| AppError::A11y(format!("Failed to get focused element: {}", e)))?;

        // Fallback: climb from the focused element to its foreground / top-level window root
        if let (Ok(desktop), Ok(walker)) = (
            self.automation.get_root_element(),
            self.automation.get_control_view_walker(),
        ) {
            let fg_hex = if fg_is_valid {
                Some(format!("0x{:X}", fg_hwnd.0 as isize))
            } else {
                None
            };
            let mut curr = focused.clone();
            for _ in 0..32 {
                if let Some(ref target_hex) = fg_hex {
                    if curr
                        .get_native_window_handle()
                        .map(|h| h.to_string() == *target_hex)
                        .unwrap_or(false)
                    {
                        return Ok(curr);
                    }
                }
                match walker.get_parent(&curr) {
                    Ok(parent) => {
                        if self
                            .automation
                            .compare_elements(&parent, &desktop)
                            .unwrap_or(false)
                        {
                            return Ok(curr);
                        }
                        curr = parent;
                    }
                    Err(_) => break,
                }
            }
        }

        Ok(focused)
    }

    fn parse_element(
        &self,
        element: &UIElement,
        depth: usize,
        max_depth: usize,
        remaining: &mut usize,
    ) -> A11yNode {
        *remaining = remaining.saturating_sub(1);

        let name = element.get_name().unwrap_or_default();
        let class_name = element.get_classname().unwrap_or_default();
        let control_type = element
            .get_control_type()
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
            "Button"
                | "Edit"
                | "MenuItem"
                | "Hyperlink"
                | "CheckBox"
                | "RadioButton"
                | "ComboBox"
                | "TabItem"
                | "ListItem"
        );

        let mut children = Vec::new();
        if depth < max_depth && *remaining > 0 {
            if let Ok(walker) = self.automation.get_control_view_walker() {
                if let Ok(first_child) = walker.get_first_child(element) {
                    let mut curr = Some(first_child);
                    while let Some(child) = curr {
                        if *remaining == 0 {
                            break;
                        }
                        children.push(self.parse_element(&child, depth + 1, max_depth, remaining));
                        if *remaining == 0 {
                            break;
                        }
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
        let target = self.resolve_target_window()?;

        let window_title = target
            .get_name()
            .unwrap_or_else(|_| "Unknown Window".to_string());
        let mut remaining = MAX_A11Y_NODES;
        let root = self.parse_element(&target, 0, max_depth, &mut remaining);

        Ok(A11yTree {
            window_title,
            root,
        })
    }
}
