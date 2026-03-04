"""
Ops-Navigator — 진입점 (네비게이션 제어)
"""
import streamlit as st

st.set_page_config(
    page_title="Ops-Navigator",
    page_icon="💬",
    layout="wide",
    initial_sidebar_state="expanded",
)

pg = st.navigation([
    st.Page("pages/1_Chat.py", title="Chat", icon="💬"),
    st.Page("pages/2_Admin.py", title="Admin", icon="🗄️"),
])
pg.run()
