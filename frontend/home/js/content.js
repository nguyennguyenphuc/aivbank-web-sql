// Nội dung viết tay cho trang lộ trình eDA (bổ sung cho data.js sinh từ Excel).
window.EDA_CONTENT = {
  // Nhóm kiến thức dùng cho bộ lọc ở phần nội dung các module
  areas: [
    { key: "excel",  code: "EXCEL",  name: "Excel",                    note: "Excel từ làm sạch dữ liệu, Power Query đến Data Model, Pivot Table và DAX." },
    { key: "bi",     code: "BI",     name: "Power BI và công cụ BI",   note: "Power BI (Power Query, mô hình dữ liệu, DAX, dashboard, tối ưu báo cáo), Tableau và Looker." },
    { key: "sql",    code: "SQL",    name: "SQL và kho dữ liệu",       note: "SQL trên BigQuery, Window Function, CTE, tối ưu truy vấn, cùng Snowflake và Microsoft Fabric." },
    { key: "py",     code: "PY",     name: "Python và data pipeline",  note: "Python cho phân tích dữ liệu, thu thập dữ liệu, kiểm định bằng Pydantic, biến đổi bằng DBT và xây dựng data pipeline." },
    { key: "ai",     code: "AI",     name: "Agentic AI",               note: "Agentic AI trong Excel, Power BI và SQL, cùng Claude/Copilot và Harness Engineering." },
    { key: "stat",   code: "STAT",   name: "Thống kê và học máy",      note: "Thống kê mô tả, khoảng tin cậy, p-value, A/B testing, hồi quy, K-Means, KNN và cây quyết định." },
    { key: "domain", code: "LV",     name: "Lĩnh vực nghiệp vụ",       note: "Seminar lĩnh vực ở đầu mỗi module (tự chọn) và dự án theo ngành Sales, HR, Finance, Marketing, Game, Supply Chain, Operations." },
    { key: "kn",     code: "KN",     name: "Kỹ năng mềm",              note: "Xác định vấn đề, làm việc với các bên liên quan, tư duy kinh doanh, tư duy logic, thuyết trình và làm việc nhóm." }
  ],

  stages: [
    { n: "01", name: "Nền tảng",                         mods: "M1, M2" },
    { n: "02", name: "BI và SQL nâng cao",               mods: "M3" },
    { n: "03", name: "AI trong phân tích dữ liệu",       mods: "M4" },
    { n: "04", name: "Nền tảng đám mây và data pipeline", mods: "M5, M6" },
    { n: "05", name: "Mở rộng sang học máy",             mods: "M7" }
  ],

  // short, lane, pre: dùng cho sơ đồ tiến trình. lane (màu ô) 0: Excel và BI, 1: SQL và dữ liệu, 2: AI và học máy. pre: module liền trước, các module học nối tiếp nhau
  modules: [
    {
      code: "M1", n: "01", title: "Nền tảng phân tích dữ liệu với Excel", en: "Foundation of Data Analytics",
      short: "Nền tảng|với Excel", lane: 0, pre: [],
      domain: "Sales Analytics", tool: "Excel",
      main: "Dữ liệu dạng bảng và cách lưu trữ, thống kê cơ bản, trực quan hoá với Excel, làm sạch dữ liệu, Power Query, Pivot Table, mô hình dữ liệu và DAX",
      extra: "Seminar về phân tích dữ liệu trong Sales, kỹ năng mềm Problem Framing, dự án phân tích dữ liệu Sales bằng Excel",
      theory: [["excel", "Power Query"], ["excel", "Pivot và Data Model"], ["excel", "DAX trong Excel"], ["stat", "Thống kê mô tả"]],
      practice: [["domain", "Sales Analytics"], ["kn", "Problem Framing"]],
      projects: ["nexa"]
    },
    {
      code: "M2", n: "02", title: "Truy vấn dữ liệu và Business Intelligence", en: "Data Query and Business Intelligence",
      short: "Power BI", lane: 0, pre: ["M1"],
      domain: "HR", tool: "Power BI, BigQuery",
      main: "Power BI với dữ liệu Excel và CSV, cơ sở dữ liệu và BigQuery, Power Query, mô hình dữ liệu, DAX, dashboard và kể chuyện bằng dữ liệu",
      extra: "Seminar về phân tích dữ liệu trong HR, dự án tối ưu báo cáo Power BI, dự án phân tích dữ liệu HR",
      theory: [["bi", "Power Query và mô hình dữ liệu"], ["bi", "DAX"], ["sql", "BigQuery cơ bản"]],
      practice: [["bi", "Dashboard và Data Storytelling"], ["bi", "Tối ưu báo cáo Power BI"], ["domain", "HR"]],
      projects: ["hr"]
    },
    {
      code: "M3", n: "03", title: "Power BI nâng cao và SQL", en: "Advanced Power BI and SQL",
      short: "Power BI|nâng cao, SQL", lane: 1, pre: ["M2"],
      domain: "Finance", tool: "SQL, BigQuery, Power BI",
      main: "SQL trên BigQuery gồm truy xuất, tổng hợp và tính toán, làm sạch dữ liệu, Window Function và CTE, tối ưu truy vấn",
      extra: "Seminar về phân tích dữ liệu trong Finance, kỹ năng mềm làm việc với các bên liên quan, kiến trúc dữ liệu Bronze, Silver, Gold, dự án Power BI và SQL cho Finance",
      theory: [["sql", "Truy xuất và tổng hợp dữ liệu"], ["sql", "Window Function và CTE"], ["sql", "Tối ưu truy vấn"]],
      practice: [["sql", "Làm sạch dữ liệu bằng SQL"], ["domain", "Finance"], ["kn", "Làm việc với các bên liên quan"]],
      projects: ["bank", "bva"]
    },
    {
      code: "M4", n: "04", title: "Agentic AI trong phân tích dữ liệu", en: "Agentic AI for Data Analytics",
      short: "Agentic AI", lane: 2, pre: ["M3"],
      domain: "Nhiều lĩnh vực", dprojects: "Game, EdTech, Omnichannel Marketing, Digital Marketing", tool: "Agentic AI, Claude/Copilot",
      main: "Agentic AI trong Excel (dự án Game), Agentic AI trong Power BI (dự án EdTech), Agentic AI cho truy xuất và biến đổi dữ liệu bằng SQL (dự án Omnichannel Marketing), Claude/Copilot cho dự án Digital Marketing",
      extra: "Harness Engineering cho phân tích Digital Marketing, bốn dự án thực hiện trọn quy trình phân tích",
      theory: [["ai", "Agentic AI trong Excel"], ["ai", "Agentic AI trong Power BI"], ["ai", "Agentic AI cho SQL"]],
      practice: [["ai", "Harness Engineering"], ["domain", "Dự án Game"], ["domain", "Dự án EdTech"], ["domain", "Dự án Omnichannel Marketing"], ["domain", "Dự án Digital Marketing"]],
      projects: ["game", "beauty"]
    },
    {
      code: "M5", n: "05", title: "Phân tích dữ liệu trên nền tảng đám mây", en: "Modern Analytics Ecosystem",
      short: "Nền tảng|dữ liệu đám mây", lane: 1, pre: ["M4"],
      domain: "Supply Chain", tool: "Snowflake, Fabric, Tableau, Looker",
      main: "Truy xuất dữ liệu từ Snowflake và Microsoft Fabric, giải thích kết quả phân tích bằng thống kê nâng cao (khoảng tin cậy, p-value, A/B testing), Tableau và Looker",
      extra: "Seminar về phân tích dữ liệu trong Supply Chain, kỹ năng mềm tư duy phân tích và kinh doanh, dự án phân tích trọn quy trình trên nền tảng đám mây",
      theory: [["sql", "Snowflake"], ["sql", "Microsoft Fabric"], ["stat", "Khoảng tin cậy, p-value, A/B testing"]],
      practice: [["bi", "Tableau"], ["bi", "Looker"], ["domain", "Supply Chain"], ["kn", "Tư duy kinh doanh"]],
      projects: ["sc"]
    },
    {
      code: "M6", n: "06", title: "Data pipeline và tự động hoá", en: "Data Pipeline and Automation",
      short: "Data pipeline|tự động hoá", lane: 1, pre: ["M5"],
      domain: "Operations Analytics", tool: "Python, Pydantic, DBT",
      main: "Python cho phân tích dữ liệu, nguồn dữ liệu và thu thập dữ liệu, kiểm định dữ liệu bằng Pydantic, biến đổi dữ liệu bằng DBT (SQL), triển khai data pipeline",
      extra: "Seminar về phân tích dữ liệu trong Operations, kỹ năng mềm tư duy logic và giải quyết vấn đề, dự án data pipeline kết hợp EDA tự động",
      theory: [["py", "Python cho phân tích dữ liệu"], ["py", "Pydantic"], ["py", "DBT"]],
      practice: [["py", "Data pipeline"], ["domain", "Operations"], ["kn", "Tư duy logic, giải quyết vấn đề"]],
      projects: ["ops", "steel"]
    },
    {
      code: "M7", n: "07", title: "Dự báo, phân cụm và phát hiện bất thường", en: "Forecasting, Clustering and Anomaly Detection",
      short: "Dự báo và|học máy", lane: 2, pre: ["M6"],
      domain: "Credit Risk, Recommendation", tool: "Pandas, Plotly, scikit-learn",
      main: "Pandas và Plotly cho EDA tự động, dự báo doanh số bằng hồi quy tuyến tính, phân khúc khách hàng bằng K-Means, phát hiện bất thường trong rủi ro tín dụng bằng KNN, Decision Tree, Random Forest",
      extra: "Kỹ năng mềm thuyết trình và làm việc nhóm, dự án phân tích rủi ro tín dụng và hệ thống gợi ý, bài thi cuối khoá gồm hai phần (SQL và Power BI, phân tích nâng cao)",
      theory: [["py", "EDA tự động"], ["stat", "Hồi quy tuyến tính"], ["stat", "K-Means và KNN"], ["stat", "Decision Tree và Random Forest"]],
      practice: [["domain", "Credit Risk"], ["kn", "Thuyết trình và làm việc nhóm"]],
      projects: ["dsm"]
    }
  ],

  optional: {
    code: "M8", n: "08", title: "Luyện thi chứng chỉ (tự chọn)", en: "Certification Prep",
    main: "Microsoft PL-300 (Power BI Data Analyst) và AWS Certified Cloud Practitioner",
    extra: "Lịch học thông báo sau khi kết thúc khoá chính"
  },

  // Chuẩn đầu ra của chương trình (dự thảo, cần người phụ trách chương trình duyệt)
  plos: [
    { code: "CĐR1", short: "Nghiệp vụ",          text: "Hiểu nghiệp vụ của lĩnh vực, xác định đúng câu hỏi phân tích và chọn chỉ số phù hợp." },
    { code: "CĐR2", short: "Chuẩn bị dữ liệu",   text: "Thu thập, làm sạch, kiểm định và biến đổi dữ liệu bằng Excel, SQL và Python." },
    { code: "CĐR3", short: "Mô hình dữ liệu",    text: "Viết truy vấn SQL nâng cao, xây dựng mô hình dữ liệu dạng sao và tính chỉ số bằng DAX." },
    { code: "CĐR4", short: "Trực quan hoá",      text: "Xây dựng dashboard và trình bày kết quả bằng Excel, Power BI, Tableau, Looker." },
    { code: "CĐR5", short: "Thống kê, học máy",  text: "Dùng thống kê, A/B testing và các mô hình học máy cơ bản để giải thích và dự báo." },
    { code: "CĐR6", short: "Pipeline, đám mây",  text: "Làm việc với kho dữ liệu trên nền tảng đám mây và xây dựng data pipeline tự động." },
    { code: "CĐR7", short: "Ứng dụng AI",        text: "Dùng Agentic AI để rút ngắn và tự động hoá các bước trong quy trình phân tích." },
    { code: "CĐR8", short: "Kỹ năng nghề",       text: "Làm việc với các bên liên quan, thuyết trình kết quả và làm việc nhóm." }
  ],

  // Ma trận module và chuẩn đầu ra. I: giới thiệu, R: củng cố, M: thành thạo, A: đánh giá tổng kết
  cmap: [
    { row: "M1", label: "Nền tảng với Excel",     v: ["I", "I", "I", "I", "I", "", "", "I"] },
    { row: "M2", label: "Power BI",               v: ["R", "R", "R", "R", "", "I", "", ""] },
    { row: "M3", label: "Power BI nâng cao, SQL", v: ["R", "R", "M", "R", "", "R", "", "R"] },
    { row: "M4", label: "Agentic AI",             v: ["R", "R", "R", "R", "", "", "I M", ""] },
    { row: "M5", label: "Nền tảng dữ liệu đám mây",  v: ["R", "", "R", "M", "R", "R", "", "R"] },
    { row: "M6", label: "Data pipeline",          v: ["R", "M", "R", "", "", "M", "", "R"] },
    { row: "M7", label: "Dự báo và học máy",      v: ["M", "R", "", "R", "M", "", "", "M"] },
    { row: "Thi", label: "Bài thi cuối khoá",     v: ["", "A", "A", "A", "A", "", "", ""] },
    { row: "TC", label: "Dự án mentorship (tự chọn)", v: ["M", "", "", "", "", "", "", "R"], opt: true }
  ],

  skills: [
    { name: "Pivot Table",     m: "M01", icon: "pivot" },
    { name: "Power Query",     m: "M01", icon: "query" },
    { name: "DAX",             m: "M02", icon: "dax" },
    { name: "Star Schema",     m: "M02", icon: "star" },
    { name: "BigQuery SQL",    m: "M03", icon: "sql" },
    { name: "Window Function", m: "M03", icon: "window" },
    { name: "Agentic AI",      m: "M04", icon: "agent" },
    { name: "A/B Testing",     m: "M05", icon: "ab" },
    { name: "Snowflake",       m: "M05", icon: "flake" },
    { name: "DBT Pipeline",    m: "M06", icon: "pipe" },
    { name: "K-Means",         m: "M07", icon: "kmeans" },
    { name: "Random Forest",   m: "M07", icon: "tree" }
  ],

  // Lĩnh vực chuyên sâu cho dự án mentorship (người học tự chọn lĩnh vực và mentor)
  mentorGroups: [
    { key: "fin",    name: "Tài chính, Ngân hàng, Kế toán" },
    { key: "hr",     name: "Nhân sự" },
    { key: "retail", name: "Bán lẻ và Sales" },
    { key: "mkt",    name: "Marketing" },
    { key: "game",   name: "Game và sản phẩm số" },
    { key: "sc",     name: "Chuỗi cung ứng" },
    { key: "ops",    name: "Vận hành và Sản xuất" }
  ],

  // Dự án mentorship. g: lĩnh vực; from: module cần học trước để đủ kỹ năng nền; m: module cùng lĩnh vực
  projects: {
    nexa:   { g: "retail", from: "M1", m: ["M1"], domain: "Sales, Retail", title: "Nexa Home: đối soát doanh thu và kết quả bán hàng",
              desc: "Đối soát doanh thu giữa các nguồn, xây dựng Data Model bằng Power Query và hơn 29 measure DAX, trình bày kết quả bằng dashboard và slide.",
              tools: ["Excel", "Power Query", "DAX"] },
    bva:    { g: "fin", from: "M1", m: ["M3"], domain: "Finance, Accounting", title: "Phân tích ngân sách và thực tế theo chuẩn VAS (năm tài chính 2024)",
              desc: "Làm sạch sổ cái 2.525 dòng và 43 cột, phân tích chênh lệch giữa ngân sách và thực tế, xây dựng ba dashboard cho giám đốc tài chính, trưởng phòng tài chính và trưởng các bộ phận.",
              tools: ["Excel", "Pivot", "Dashboard"] },
    steel:  { g: "ops", from: "M1", m: ["M6"], domain: "Manufacturing", title: "Phân tích lỗi tấm thép trên dây chuyền sản xuất",
              desc: "Khám phá dữ liệu 7 loại lỗi tấm thép, làm sạch và trực quan hoá trong Excel, có nhận xét của chuyên viên phân tích dữ liệu nhiều kinh nghiệm.",
              tools: ["Excel", "Thống kê mô tả"] },
    bank:   { g: "fin", from: "M3", m: ["M3"], domain: "Banking, Finance", title: "AIV Bank: hệ thống ngân hàng lõi mô phỏng",
              desc: "Dữ liệu ngân hàng mô phỏng, truy vấn SQL trên BigQuery và DuckDB, xây dựng mô hình dữ liệu dạng sao trong Power BI và dashboard chỉ số tài chính. Kèm SQL Lab chạy trên trình duyệt để luyện truy vấn trên chính bộ dữ liệu này.",
              tools: ["BigQuery", "SQL", "Power BI"] },
    beauty: { g: "mkt", from: "M3", m: ["M4"], domain: "Digital Marketing", title: "Marketing thương mại điện tử ngành mỹ phẩm: Nykaa, Purplle, Tira",
              desc: "Trích xuất dữ liệu chiến dịch bằng SQL, làm sạch, tính các chỉ số và xây dựng dashboard phễu chuyển đổi, ROI theo kênh.",
              tools: ["SQL", "Excel", "Dashboard"] },
    game:   { g: "game", from: "M4", m: ["M4"], domain: "Game", title: "Nebula Quest: nguyên nhân chỉ số Android giảm sau bản 2.1.0",
              desc: "Phân tích activation, retention và monetization sau bản cập nhật, đề xuất có nên cắt giảm kênh quảng cáo trả phí, với sự hỗ trợ của Agentic AI trong Excel.",
              tools: ["Excel", "Agentic AI", "Cohort"] },
    hr:     { g: "hr", from: "M2", m: ["M2"], domain: "HR, People", title: "Phân tích nhân sự: nghỉ việc và cơ cấu lương",
              desc: "Lấy dữ liệu nhân sự từ BigQuery, xây dựng mô hình dữ liệu dạng sao bằng dbt và dashboard Power BI. Dùng kiểm định giả thuyết và hồi quy để giải thích tình trạng nghỉ việc và chênh lệch lương.",
              tools: ["BigQuery", "dbt", "Power BI"] },
    sc:     { g: "sc", from: "M5", m: ["M5"], domain: "Supply Chain", title: "Chuỗi cung ứng: 8 bài thực hành từ tồn kho đến A/B testing",
              desc: "ITR và GMROI, phân cụm cửa hàng, dự báo nhu cầu, ABC-XYZ, OTIF, chọn vị trí kho, khoảng tin cậy và A/B testing, kèm dashboard trên Power BI và Tableau.",
              tools: ["Power BI", "Tableau", "Python"] },
    ops:    { g: "ops", from: "M6", m: ["M6"], domain: "Operations", title: "Phân tích vận hành mạng lưới với dbt và Snowflake",
              desc: "Xây dựng pipeline từ Snowflake qua dbt (có Git và kiểm thử) đến Power BI cho số liệu vận hành mạng lưới, theo quy trình làm việc nhóm.",
              tools: ["Snowflake", "dbt", "Power BI"] },
    dsm:    { g: "mkt", from: "M7", m: ["M4", "M7"], domain: "Marketing Data Science", title: "Phân loại chiến dịch marketing lỗ và lãi",
              desc: "Phân loại chiến dịch marketing lỗ hoặc lãi bằng mô hình cây quyết định và boosting, giải thích kết quả bằng SHAP và kiểm chứng bằng thống kê.",
              tools: ["Python", "XGBoost", "SHAP"] }
  },

  team: [
    { name: "Nguyễn Hồng Phúc",   deg: "PhD",                   slug: "nguyen-hong-phuc" },
    { name: "Đinh Quang Vinh",    deg: "PhD",                   slug: "dinh-quang-vinh" },
    { name: "Nguyễn Đình Vinh",   deg: "PhD",                   slug: "nguyen-dinh-vinh" },
    { name: "Nguyễn Thái Hà",     deg: "PhD",                   slug: "nguyen-thai-ha" },
    { name: "Nguyễn Quốc Thái",   deg: "MSc",                   slug: "nguyen-quoc-thai" },
    { name: "Nguyễn Thanh Hà",    deg: "MSc",                   slug: "nguyen-thanh-ha" },
    { name: "Đinh Thị Lan Hương", deg: "MSc",                   slug: "dinh-thi-lan-huong" },
    { name: "Huỳnh Lê Kim Long",  deg: "Mobile App Analytics",  slug: "huynh-le-kim-long" },
    { name: "Vũ Quang Huy",       deg: "Finance Analytics",     slug: "vu-quang-huy" },
    { name: "Nguyễn Thị Nga",     deg: "Retail",                slug: "nguyen-thi-nga" }
  ]
};
